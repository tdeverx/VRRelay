// SPDX-License-Identifier: GPL-3.0-or-later
import { Pool, type PoolConfig } from 'pg';
import type {
  ClusterNode,
  CompatibilityResult,
  LiveChannel,
  PersonalAccessToken,
  PlaybackGrant,
  ProviderBinding,
  NodeCertificateState,
  AgentLogEntry,
  ProfileRevision,
  ProviderConnection,
  RelaySession,
  SegmentJob
} from '@vrrelay/domain';
import type { ClusterRepository, Repository } from '@vrrelay/application';

export class PostgresRepository implements Repository, ClusterRepository {
  readonly #pool: Pool;

  constructor(config: string | PoolConfig) {
    this.#pool = new Pool(typeof config === 'string' ? { connectionString: config } : config);
    // pg emits failures from idle clients on the pool itself. If this event has
    // no listener, a routine database restart terminates the Node process.
    // Active repository operations still reject normally and can be retried by
    // the caller once the pool reconnects.
    this.#pool.on('error', () => undefined);
  }

  async migrate(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS profiles(profile_id TEXT NOT NULL, revision INTEGER NOT NULL, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(profile_id, revision));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS playback_grants(token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL);
      CREATE INDEX IF NOT EXISTS playback_grants_session ON playback_grants(session_id);
      CREATE TABLE IF NOT EXISTS live_channels(id TEXT PRIMARY KEY, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS compatibility_results(id TEXT PRIMARY KEY, document JSONB NOT NULL, tested_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_tokens(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS cluster_nodes(id TEXT PRIMARY KEY, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS segment_jobs(id TEXT PRIMARY KEY, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_bindings(id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, node_id TEXT NOT NULL, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE INDEX IF NOT EXISTS provider_bindings_provider ON provider_bindings(provider_id);
      CREATE INDEX IF NOT EXISTS provider_bindings_node ON provider_bindings(node_id);
      CREATE TABLE IF NOT EXISTS node_certificates(serial_number TEXT PRIMARY KEY, node_id TEXT NOT NULL, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL);
      CREATE INDEX IF NOT EXISTS node_certificates_node ON node_certificates(node_id);
      CREATE TABLE IF NOT EXISTS agent_logs(id TEXT PRIMARY KEY, node_id TEXT NOT NULL, document JSONB NOT NULL, timestamp TIMESTAMPTZ NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_logs_node_time ON agent_logs(node_id, timestamp DESC);
      INSERT INTO schema_migrations(version, applied_at) VALUES(1, NOW()) ON CONFLICT DO NOTHING;
      INSERT INTO schema_migrations(version, applied_at) VALUES(2, NOW()) ON CONFLICT DO NOTHING;
    `);
  }

  async putProvider(value: ProviderConnection) {
    await this.#put('providers', 'id', value.id, value, 'updated_at', value.updatedAt);
  }
  async listProviders() {
    return this.#list<ProviderConnection>('providers', 'updated_at DESC');
  }
  async getProvider(id: string) {
    return this.#get<ProviderConnection>('providers', 'id', id);
  }
  async deleteProvider(id: string) {
    await this.#pool.query('DELETE FROM providers WHERE id=$1', [id]);
  }

  async putProfile(value: ProfileRevision): Promise<void> {
    await this.#pool.query(
      'INSERT INTO profiles(profile_id,revision,document,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [value.profileId, value.revision, value, value.createdAt]
    );
  }
  async listProfiles() {
    return this.#list<ProfileRevision>('profiles', 'profile_id, revision DESC');
  }
  async getProfile(id: string, revision?: number): Promise<ProfileRevision | undefined> {
    const result = revision
      ? await this.#pool.query(
          'SELECT document FROM profiles WHERE profile_id=$1 AND revision=$2',
          [id, revision]
        )
      : await this.#pool.query(
          'SELECT document FROM profiles WHERE profile_id=$1 ORDER BY revision DESC LIMIT 1',
          [id]
        );
    return result.rows[0]?.document as ProfileRevision | undefined;
  }

  async putSession(value: RelaySession) {
    await this.#put('sessions', 'id', value.id, value, 'updated_at', value.updatedAt);
  }
  async listSessions() {
    return this.#list<RelaySession>('sessions', 'updated_at DESC');
  }
  async getSession(id: string) {
    return this.#get<RelaySession>('sessions', 'id', id);
  }
  async deleteSession(id: string) {
    await this.#pool.query('DELETE FROM sessions WHERE id=$1', [id]);
  }

  async putPlaybackGrant(value: PlaybackGrant): Promise<void> {
    await this.#pool.query(
      'INSERT INTO playback_grants(token_hash,session_id,document,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(token_hash) DO UPDATE SET document=EXCLUDED.document',
      [value.tokenHash, value.sessionId, value, value.createdAt]
    );
  }
  async getPlaybackGrant(hash: string) {
    return this.#get<PlaybackGrant>('playback_grants', 'token_hash', hash);
  }
  async revokePlaybackGrants(sessionId: string): Promise<void> {
    const result = await this.#pool.query(
      'SELECT token_hash,document FROM playback_grants WHERE session_id=$1',
      [sessionId]
    );
    const now = new Date().toISOString();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of result.rows as Array<{ token_hash: string; document: PlaybackGrant }>) {
        await client.query('UPDATE playback_grants SET document=$1 WHERE token_hash=$2', [
          { ...row.document, revokedAt: now },
          row.token_hash
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async putLiveChannel(value: LiveChannel) {
    await this.#put('live_channels', 'id', value.id, value, 'created_at', value.createdAt);
  }
  async listLiveChannels() {
    return this.#list<LiveChannel>('live_channels', 'created_at DESC');
  }
  async getLiveChannel(id: string) {
    return this.#get<LiveChannel>('live_channels', 'id', id);
  }
  async deleteLiveChannel(id: string) {
    await this.#pool.query('DELETE FROM live_channels WHERE id = $1', [id]);
  }
  async putCompatibilityResult(value: CompatibilityResult) {
    await this.#put('compatibility_results', 'id', value.id, value, 'tested_at', value.testedAt);
  }
  async listCompatibilityResults() {
    return this.#list<CompatibilityResult>('compatibility_results', 'tested_at DESC');
  }

  async putPersonalToken(value: PersonalAccessToken): Promise<void> {
    await this.#pool.query(
      'INSERT INTO personal_tokens(id,token_hash,document,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET token_hash=EXCLUDED.token_hash,document=EXCLUDED.document',
      [value.id, value.tokenHash, value, value.createdAt]
    );
  }
  async getPersonalToken(hash: string) {
    return this.#get<PersonalAccessToken>('personal_tokens', 'token_hash', hash);
  }
  async listPersonalTokens() {
    return this.#list<PersonalAccessToken>('personal_tokens', 'created_at DESC');
  }
  async revokePersonalToken(id: string): Promise<void> {
    const result = await this.#pool.query('SELECT document FROM personal_tokens WHERE id=$1', [id]);
    const value = result.rows[0]?.document as PersonalAccessToken | undefined;
    if (value) await this.putPersonalToken({ ...value, revokedAt: new Date().toISOString() });
  }

  async putSetting(key: string, value: string): Promise<void> {
    await this.#pool.query(
      'INSERT INTO settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
      [key, value]
    );
  }
  async getSetting(key: string): Promise<string | undefined> {
    return (await this.#pool.query('SELECT value FROM settings WHERE key=$1', [key])).rows[0]
      ?.value as string | undefined;
  }

  async putNode(value: ClusterNode) {
    await this.#put('cluster_nodes', 'id', value.id, value, 'updated_at', value.updatedAt);
  }
  async getNode(id: string) {
    return this.#get<ClusterNode>('cluster_nodes', 'id', id);
  }
  async listNodes() {
    return this.#list<ClusterNode>('cluster_nodes', 'updated_at DESC');
  }
  async deleteNode(id: string) {
    await this.#pool.query('DELETE FROM cluster_nodes WHERE id=$1', [id]);
  }
  async putSegmentJob(value: SegmentJob) {
    await this.#put('segment_jobs', 'id', value.id, value, 'updated_at', value.updatedAt);
  }
  async getSegmentJob(id: string) {
    return this.#get<SegmentJob>('segment_jobs', 'id', id);
  }
  async listSegmentJobs(limit = 100): Promise<SegmentJob[]> {
    return (
      await this.#pool.query(
        'SELECT document FROM segment_jobs ORDER BY updated_at DESC LIMIT $1',
        [limit]
      )
    ).rows.map((row) => row.document as SegmentJob);
  }
  async putProviderBinding(value: ProviderBinding): Promise<void> {
    await this.#pool.query(
      `INSERT INTO provider_bindings(id,provider_id,node_id,document,updated_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET provider_id=EXCLUDED.provider_id,node_id=EXCLUDED.node_id,document=EXCLUDED.document,updated_at=EXCLUDED.updated_at`,
      [value.id, value.providerId, value.nodeId, value, value.updatedAt]
    );
  }
  async getProviderBinding(id: string) {
    return this.#get<ProviderBinding>('provider_bindings', 'id', id);
  }
  async listProviderBindings(providerId?: string): Promise<ProviderBinding[]> {
    const result = providerId
      ? await this.#pool.query(
          'SELECT document FROM provider_bindings WHERE provider_id=$1 ORDER BY updated_at DESC',
          [providerId]
        )
      : await this.#pool.query('SELECT document FROM provider_bindings ORDER BY updated_at DESC');
    return result.rows.map((row) => row.document as ProviderBinding);
  }
  async deleteProviderBinding(id: string) {
    await this.#pool.query('DELETE FROM provider_bindings WHERE id=$1', [id]);
  }
  async putNodeCertificate(value: NodeCertificateState): Promise<void> {
    await this.#pool.query(
      `INSERT INTO node_certificates(serial_number,node_id,document,created_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(serial_number) DO UPDATE SET document=EXCLUDED.document`,
      [value.serialNumber, value.nodeId, value, value.createdAt]
    );
  }
  async listNodeCertificates(nodeId: string): Promise<NodeCertificateState[]> {
    return (
      await this.#pool.query(
        'SELECT document FROM node_certificates WHERE node_id=$1 ORDER BY created_at DESC',
        [nodeId]
      )
    ).rows.map((row) => row.document as NodeCertificateState);
  }
  async putAgentLog(value: AgentLogEntry): Promise<void> {
    await this.#pool.query(
      'INSERT INTO agent_logs(id,node_id,document,timestamp) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET document=EXCLUDED.document',
      [value.id, value.nodeId, value, value.timestamp]
    );
    await this.#pool.query(
      `DELETE FROM agent_logs WHERE node_id=$1 AND id NOT IN
      (SELECT id FROM agent_logs WHERE node_id=$1 ORDER BY timestamp DESC LIMIT 1000)`,
      [value.nodeId]
    );
  }
  async listAgentLogs(nodeId: string, limit = 200): Promise<AgentLogEntry[]> {
    return (
      await this.#pool.query(
        'SELECT document FROM agent_logs WHERE node_id=$1 ORDER BY timestamp DESC LIMIT $2',
        [nodeId, limit]
      )
    ).rows.map((row) => row.document as AgentLogEntry);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #put(
    table: string,
    keyColumn: string,
    key: string,
    document: object,
    dateColumn: string,
    date: string
  ): Promise<void> {
    await this.#pool.query(
      `INSERT INTO ${table}(${keyColumn},document,${dateColumn}) VALUES($1,$2,$3) ON CONFLICT(${keyColumn}) DO UPDATE SET document=EXCLUDED.document,${dateColumn}=EXCLUDED.${dateColumn}`,
      [key, document, date]
    );
  }
  async #get<T>(table: string, keyColumn: string, key: string): Promise<T | undefined> {
    return (await this.#pool.query(`SELECT document FROM ${table} WHERE ${keyColumn}=$1`, [key]))
      .rows[0]?.document as T | undefined;
  }
  async #list<T>(table: string, order: string): Promise<T[]> {
    return (await this.#pool.query(`SELECT document FROM ${table} ORDER BY ${order}`)).rows.map(
      (row) => row.document as T
    );
  }
}
