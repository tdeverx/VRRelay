// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  CompatibilityResult,
  ClusterNode,
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

type StoredEntity =
  | ProviderConnection
  | ProfileRevision
  | RelaySession
  | PlaybackGrant
  | LiveChannel
  | CompatibilityResult
  | PersonalAccessToken;

export class SqliteRepository implements Repository, ClusterRepository {
  readonly #db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.pragma('busy_timeout = 5000');
  }

  async migrate(): Promise<void> {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        profile_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, revision)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playback_grants (
        token_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS playback_grants_session ON playback_grants(session_id);
      CREATE TABLE IF NOT EXISTS live_channels (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compatibility_results (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        tested_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cluster_nodes (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS segment_jobs (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_bindings (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS provider_bindings_provider ON provider_bindings(provider_id);
      CREATE INDEX IF NOT EXISTS provider_bindings_node ON provider_bindings(node_id);
      CREATE TABLE IF NOT EXISTS node_certificates (
        serial_number TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS node_certificates_node ON node_certificates(node_id);
      CREATE TABLE IF NOT EXISTS agent_logs (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        json TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_logs_node_time ON agent_logs(node_id, timestamp DESC);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (1, datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (2, datetime('now'));
    `);
  }

  async putProvider(provider: ProviderConnection): Promise<void> {
    this.#put('providers', 'id', provider.id, provider, 'updated_at', provider.updatedAt);
  }

  async listProviders(): Promise<ProviderConnection[]> {
    return this.#list<ProviderConnection>('providers', 'updated_at DESC');
  }

  async getProvider(id: string): Promise<ProviderConnection | undefined> {
    return this.#get<ProviderConnection>('providers', 'id', id);
  }

  async deleteProvider(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  async putProfile(profile: ProfileRevision): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO profiles(profile_id, revision, json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, revision) DO NOTHING`
      )
      .run(profile.profileId, profile.revision, JSON.stringify(profile), profile.createdAt);
  }

  async listProfiles(): Promise<ProfileRevision[]> {
    return this.#list<ProfileRevision>('profiles', 'profile_id, revision DESC');
  }

  async getProfile(id: string, revision?: number): Promise<ProfileRevision | undefined> {
    const row = revision
      ? this.#db
          .prepare('SELECT json FROM profiles WHERE profile_id = ? AND revision = ?')
          .get(id, revision)
      : this.#db
          .prepare('SELECT json FROM profiles WHERE profile_id = ? ORDER BY revision DESC LIMIT 1')
          .get(id);
    return this.#parseRow<ProfileRevision>(row);
  }

  async putSession(session: RelaySession): Promise<void> {
    this.#put('sessions', 'id', session.id, session, 'updated_at', session.updatedAt);
  }

  async listSessions(): Promise<RelaySession[]> {
    return this.#list<RelaySession>('sessions', 'updated_at DESC');
  }

  async getSession(id: string): Promise<RelaySession | undefined> {
    return this.#get<RelaySession>('sessions', 'id', id);
  }

  async deleteSession(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  async putPlaybackGrant(grant: PlaybackGrant): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO playback_grants(token_hash, session_id, json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET json = excluded.json`
      )
      .run(grant.tokenHash, grant.sessionId, JSON.stringify(grant), grant.createdAt);
  }

  async getPlaybackGrant(tokenHash: string): Promise<PlaybackGrant | undefined> {
    return this.#get<PlaybackGrant>('playback_grants', 'token_hash', tokenHash);
  }

  async revokePlaybackGrants(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    const rows = this.#db
      .prepare('SELECT token_hash, json FROM playback_grants WHERE session_id = ?')
      .all(sessionId) as Array<{ token_hash: string; json: string }>;
    const update = this.#db.prepare('UPDATE playback_grants SET json = ? WHERE token_hash = ?');
    this.#db.transaction(() => {
      for (const row of rows) {
        const grant = JSON.parse(row.json) as PlaybackGrant;
        update.run(JSON.stringify({ ...grant, revokedAt: now }), row.token_hash);
      }
    })();
  }

  async putLiveChannel(channel: LiveChannel): Promise<void> {
    this.#put('live_channels', 'id', channel.id, channel, 'created_at', channel.createdAt);
  }

  async listLiveChannels(): Promise<LiveChannel[]> {
    return this.#list<LiveChannel>('live_channels', 'created_at DESC');
  }

  async getLiveChannel(id: string): Promise<LiveChannel | undefined> {
    return this.#get<LiveChannel>('live_channels', 'id', id);
  }

  async deleteLiveChannel(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM live_channels WHERE id = ?').run(id);
  }

  async putCompatibilityResult(result: CompatibilityResult): Promise<void> {
    this.#put('compatibility_results', 'id', result.id, result, 'tested_at', result.testedAt);
  }

  async listCompatibilityResults(): Promise<CompatibilityResult[]> {
    return this.#list<CompatibilityResult>('compatibility_results', 'tested_at DESC');
  }

  async putPersonalToken(token: PersonalAccessToken): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO personal_tokens(id, token_hash, json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, json = excluded.json`
      )
      .run(token.id, token.tokenHash, JSON.stringify(token), token.createdAt);
  }

  async getPersonalToken(tokenHash: string): Promise<PersonalAccessToken | undefined> {
    return this.#get<PersonalAccessToken>('personal_tokens', 'token_hash', tokenHash);
  }

  async listPersonalTokens(): Promise<PersonalAccessToken[]> {
    return this.#list<PersonalAccessToken>('personal_tokens', 'created_at DESC');
  }

  async revokePersonalToken(id: string): Promise<void> {
    const row = this.#db.prepare('SELECT json FROM personal_tokens WHERE id = ?').get(id) as
      { json: string } | undefined;
    if (!row) return;
    const token = JSON.parse(row.json) as PersonalAccessToken;
    await this.putPersonalToken({ ...token, revokedAt: new Date().toISOString() });
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  async putNode(node: ClusterNode): Promise<void> {
    this.#put('cluster_nodes', 'id', node.id, node, 'updated_at', node.updatedAt);
  }

  async getNode(id: string): Promise<ClusterNode | undefined> {
    return this.#get<ClusterNode>('cluster_nodes', 'id', id);
  }

  async listNodes(): Promise<ClusterNode[]> {
    return this.#list<ClusterNode>('cluster_nodes', 'updated_at DESC');
  }

  async deleteNode(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM cluster_nodes WHERE id = ?').run(id);
  }

  async putSegmentJob(job: SegmentJob): Promise<void> {
    this.#put('segment_jobs', 'id', job.id, job, 'updated_at', job.updatedAt);
  }

  async getSegmentJob(id: string): Promise<SegmentJob | undefined> {
    return this.#get<SegmentJob>('segment_jobs', 'id', id);
  }

  async listSegmentJobs(limit = 100): Promise<SegmentJob[]> {
    const rows = this.#db
      .prepare('SELECT json FROM segment_jobs ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as SegmentJob);
  }

  async putProviderBinding(binding: ProviderBinding): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO provider_bindings(id,provider_id,node_id,json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,node_id=excluded.node_id,json=excluded.json,updated_at=excluded.updated_at`
      )
      .run(
        binding.id,
        binding.providerId,
        binding.nodeId,
        JSON.stringify(binding),
        binding.updatedAt
      );
  }

  async getProviderBinding(id: string): Promise<ProviderBinding | undefined> {
    return this.#get<ProviderBinding>('provider_bindings', 'id', id);
  }
  async listProviderBindings(providerId?: string): Promise<ProviderBinding[]> {
    const rows = providerId
      ? this.#db
          .prepare(
            'SELECT json FROM provider_bindings WHERE provider_id=? ORDER BY updated_at DESC'
          )
          .all(providerId)
      : this.#db.prepare('SELECT json FROM provider_bindings ORDER BY updated_at DESC').all();
    return (rows as Array<{ json: string }>).map((row) => JSON.parse(row.json) as ProviderBinding);
  }
  async deleteProviderBinding(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM provider_bindings WHERE id=?').run(id);
  }
  async putNodeCertificate(value: NodeCertificateState): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO node_certificates(serial_number,node_id,json,created_at) VALUES(?,?,?,?)
      ON CONFLICT(serial_number) DO UPDATE SET json=excluded.json`
      )
      .run(value.serialNumber, value.nodeId, JSON.stringify(value), value.createdAt);
  }
  async listNodeCertificates(nodeId: string): Promise<NodeCertificateState[]> {
    const rows = this.#db
      .prepare('SELECT json FROM node_certificates WHERE node_id=? ORDER BY created_at DESC')
      .all(nodeId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as NodeCertificateState);
  }
  async putAgentLog(value: AgentLogEntry): Promise<void> {
    this.#db
      .prepare('INSERT OR REPLACE INTO agent_logs(id,node_id,json,timestamp) VALUES(?,?,?,?)')
      .run(value.id, value.nodeId, JSON.stringify(value), value.timestamp);
    this.#db
      .prepare(
        `DELETE FROM agent_logs WHERE node_id=? AND id NOT IN
      (SELECT id FROM agent_logs WHERE node_id=? ORDER BY timestamp DESC LIMIT 1000)`
      )
      .run(value.nodeId, value.nodeId);
  }
  async listAgentLogs(nodeId: string, limit = 200): Promise<AgentLogEntry[]> {
    const rows = this.#db
      .prepare('SELECT json FROM agent_logs WHERE node_id=? ORDER BY timestamp DESC LIMIT ?')
      .all(nodeId, limit) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as AgentLogEntry);
  }

  close(): void {
    this.#db.close();
  }

  #put(
    table: string,
    keyColumn: string,
    key: string,
    entity: StoredEntity | ClusterNode | SegmentJob | ProviderBinding,
    dateColumn: string,
    date: string
  ): void {
    this.#db
      .prepare(
        `INSERT INTO ${table}(${keyColumn}, json, ${dateColumn}) VALUES (?, ?, ?)
         ON CONFLICT(${keyColumn}) DO UPDATE SET json = excluded.json, ${dateColumn} = excluded.${dateColumn}`
      )
      .run(key, JSON.stringify(entity), date);
  }

  #list<T>(table: string, orderBy: string): T[] {
    const rows = this.#db.prepare(`SELECT json FROM ${table} ORDER BY ${orderBy}`).all() as Array<{
      json: string;
    }>;
    return rows.map((row) => JSON.parse(row.json) as T);
  }

  #get<T>(table: string, keyColumn: string, key: string): T | undefined {
    return this.#parseRow<T>(
      this.#db.prepare(`SELECT json FROM ${table} WHERE ${keyColumn} = ?`).get(key)
    );
  }

  #parseRow<T>(row: unknown): T | undefined {
    if (!row || typeof row !== 'object' || !('json' in row) || typeof row.json !== 'string')
      return undefined;
    return JSON.parse(row.json) as T;
  }
}
