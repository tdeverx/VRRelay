// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ApplicationError,
  AuditService,
  BuiltinTrafficDirector,
  ClusterService,
  InMemoryEventBus
} from '@vrrelay/application';
import { MemoryCoordinationStore, SqliteRepository } from '@vrrelay/adapters';
import { DeleteProviderBindingQuerySchema } from '@vrrelay/contracts';
import type { AuditEvent, ClusterNode, ProviderBinding, ProviderConnection } from '@vrrelay/domain';
import { loadConfig } from './config.js';
import {
  assertSetupAuthorized,
  auditActor,
  auditedOperation,
  deleteProviderBindingWithCredentialCleanup,
  liveHlsUpstreamUrl,
  liveOriginSourceUrl,
  meteredReadable,
  providerBindingDeletionAuditContext,
  redactRequestUrl
} from './server.js';

const temporaryDirectories: string[] = [];
afterEach(async () =>
  Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
);

async function bindingCleanupFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vrrelay-binding-api-'));
  temporaryDirectories.push(directory);
  const repository = new SqliteRepository(join(directory, 'state.sqlite'));
  await repository.migrate();
  const now = new Date().toISOString();
  const node: ClusterNode = {
    id: 'binding-worker',
    name: 'Binding worker',
    roles: ['source-worker'],
    region: 'local',
    publicUrl: 'https://binding-worker.example',
    state: 'online',
    capabilities: {
      encoders: ['libx264'],
      hardwareDevices: [],
      maxWorkers: 2,
      activeWorkers: 0,
      queuedWorkers: 0,
      cacheBytes: 0,
      cacheLimitBytes: null,
      egressMbps: 0,
      providerIds: ['provider-binding-api']
    },
    weight: 100,
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now
  };
  const provider: ProviderConnection = {
    id: 'provider-binding-api',
    type: 'jellyfin',
    name: 'Binding API provider',
    baseUrl: 'https://jellyfin.example',
    authMode: 'user_token',
    secretRef: 'provider-binding:api',
    capabilities: ['search'],
    healthy: true,
    createdAt: now,
    updatedAt: now
  };
  const binding: ProviderBinding = {
    id: 'binding-api',
    providerId: provider.id,
    nodeId: node.id,
    secretRef: 'provider-binding:api:worker',
    reachable: true,
    state: 'healthy',
    deletionPending: false,
    validatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  await repository.createNode(node);
  await repository.createProviderBinding(provider, binding, null);
  const cluster = new ClusterService(
    repository,
    new MemoryCoordinationStore(),
    new BuiltinTrafficDirector(),
    new InMemoryEventBus()
  );
  return { repository, cluster, node, binding };
}

describe('payload metering', () => {
  it('records chunks that are actually consumed', async () => {
    let bytes = 0;
    const output: Buffer[] = [];
    for await (const chunk of meteredReadable(Readable.from(['hello', ' world']), (size) => {
      bytes += size;
    })) {
      output.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(output).toString()).toBe('hello world');
    expect(bytes).toBe(11);
  });
});

describe('HTTP log redaction', () => {
  it('removes playback and source grants while preserving route context', () => {
    expect(redactRequestUrl('/play/secret-grant/segment/3.ts?cache=1')).toBe(
      '/play/[REDACTED]/segment/3.ts?cache=1'
    );
    expect(redactRequestUrl('/internal/source/source-grant')).toBe('/internal/source/[REDACTED]');
    expect(redactRequestUrl('/api/v1/sessions')).toBe('/api/v1/sessions');
  });
});

describe('first-run setup authorization', () => {
  it('allows setup on a loopback public URL without a token', () => {
    expect(() =>
      assertSetupAuthorized(loadConfig({ VRRELAY_PUBLIC_URL: 'http://127.0.0.1:8099' }), undefined)
    ).not.toThrow();
  });

  it('requires a configured token for remotely reachable setup', () => {
    expect(() =>
      assertSetupAuthorized(
        loadConfig({ VRRELAY_PUBLIC_URL: 'https://relay.example.com' }),
        undefined
      )
    ).toThrow(/VRRELAY_SETUP_TOKEN/);
  });

  it('uses the configured token for remotely reachable setup', () => {
    const token = 'a-secure-bootstrap-token-with-32-characters';
    const config = loadConfig({
      VRRELAY_PUBLIC_URL: 'https://relay.example.com',
      VRRELAY_SETUP_TOKEN: token
    });
    expect(() => assertSetupAuthorized(config, token)).not.toThrow();
    expect(() => assertSetupAuthorized(config, `${token}x`)).toThrow(/invalid/);
  });
});

describe('live edge origin sources', () => {
  it('builds an authenticated SRT reader URL', () => {
    expect(liveOriginSourceUrl('srt://origin.example:8890', 'live-channel_1', 'read-token')).toBe(
      'srt://origin.example:8890?streamid=read:live-channel_1:vrrelay-read:read-token'
    );
  });

  it('keeps SRT encryption material separate from the origin address', () => {
    expect(
      liveOriginSourceUrl(
        'srt://origin.example:8890',
        'live-channel_1',
        'read-token',
        'fixture passphrase'
      )
    ).toBe(
      'srt://origin.example:8890?passphrase=fixture%20passphrase&streamid=read:live-channel_1:vrrelay-read:read-token'
    );
  });

  it('builds an authenticated RTSP reader URL without losing a base path', () => {
    expect(
      liveOriginSourceUrl('rtsp://origin.example:8554/relay', 'live-channel_1', 'read-token')
    ).toBe('rtsp://vrrelay-read:read-token@origin.example:8554/relay/live-channel_1');
  });

  it('rejects unsafe path input', () => {
    expect(() => liveOriginSourceUrl('srt://origin:8890', '../admin', 'read-token')).toThrow(
      /Invalid live path/
    );
  });
});

describe('live HLS proxy targets', () => {
  it('forwards MediaMTX session and low-latency cursor parameters', () => {
    expect(
      liveHlsUpstreamUrl('http://mediamtx:8888', 'live-channel_1', 'main_stream.m3u8', {
        session: 'session-id',
        _HLS_msn: '4',
        token: 'must-not-forward'
      })
    ).toBe('http://mediamtx:8888/live-channel_1/main_stream.m3u8?session=session-id&_HLS_msn=4');
  });

  it('rejects traversal and unsafe live paths', () => {
    expect(() =>
      liveHlsUpstreamUrl('http://mediamtx:8888', 'live-channel_1', '../config', {})
    ).toThrow(/Invalid live HLS resource/);
    expect(() =>
      liveHlsUpstreamUrl('http://mediamtx:8888', '../channel', 'index.m3u8', {})
    ).toThrow(/Invalid live path/);
  });
});

describe('administrative operation auditing', () => {
  function durableAudit(events: AuditEvent[]) {
    return new AuditService({
      appendAuditEvent: async (event) => void events.push(event),
      listAuditEvents: async () => events
    });
  }

  it('persists a structured success event without retaining sensitive operation output', async () => {
    const events: AuditEvent[] = [];
    const audit = durableAudit(events);
    const sensitiveToken = 'vrr_sensitive_personal_token';
    const sensitivePassword = 'temporary-password';

    const result = await auditedOperation(
      audit,
      {
        category: 'token',
        action: 'personal-token.create',
        actor: { type: 'administrator', id: 'local-admin' },
        context: { secretRef: sensitiveToken },
        success: (created) => ({
          target: { type: 'personal-token', id: created.id },
          context: { scopeCount: 2 }
        })
      },
      async () => ({ id: 'token-1', token: sensitiveToken, password: sensitivePassword })
    );

    expect(result.token).toBe(sensitiveToken);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      category: 'token',
      action: 'personal-token.create',
      outcome: 'attempt',
      actor: { type: 'administrator', id: 'local-admin' },
      context: { secretRef: '[redacted]' }
    });
    expect(events[1]).toMatchObject({
      category: 'token',
      action: 'personal-token.create',
      outcome: 'success',
      actor: { type: 'administrator', id: 'local-admin' },
      target: { type: 'personal-token', id: 'token-1' },
      context: { secretRef: '[redacted]', scopeCount: 2 }
    });
    expect(events[0]?.operationId).toBe(events[1]?.operationId);
    expect(JSON.stringify(events)).not.toContain(sensitiveToken);
    expect(JSON.stringify(events)).not.toContain(sensitivePassword);
  });

  it('persists a sanitized failure event and rethrows the operation error', async () => {
    const events: AuditEvent[] = [];
    const audit = durableAudit(events);
    const operationError = new ApplicationError(
      'node_unavailable',
      'temporary-password must not enter the audit log',
      409
    );

    await expect(
      auditedOperation(
        audit,
        {
          category: 'cluster',
          action: 'node.drain',
          actor: { type: 'token', id: 'pat-1' },
          target: { type: 'node', id: 'node-1' }
        },
        async () => {
          throw operationError;
        }
      )
    ).rejects.toBe(operationError);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      category: 'cluster',
      action: 'node.drain',
      outcome: 'attempt',
      actor: { type: 'token', id: 'pat-1' },
      target: { type: 'node', id: 'node-1' }
    });
    expect(events[1]).toMatchObject({
      category: 'cluster',
      action: 'node.drain',
      outcome: 'failure',
      actor: { type: 'token', id: 'pat-1' },
      target: { type: 'node', id: 'node-1' },
      context: { errorType: 'node_unavailable' }
    });
    expect(events[0]?.operationId).toBe(events[1]?.operationId);
    expect(JSON.stringify(events)).not.toContain('temporary-password');
  });

  it('preserves the original failure when failure-audit persistence also fails', async () => {
    const original = new Error('original operation error');
    let writes = 0;
    const audit = new AuditService({
      appendAuditEvent: async () => {
        writes += 1;
        if (writes === 2) throw new Error('audit storage unavailable');
      },
      listAuditEvents: async () => []
    });

    await expect(
      auditedOperation(
        audit,
        {
          category: 'backend',
          action: 'backend.activate',
          actor: auditActor({ kind: 'personal_token', id: 'pat-2', scopes: ['admin'] })
        },
        async () => {
          throw original;
        }
      )
    ).rejects.toBe(original);
  });
});

describe('provider binding deletion API lifecycle', () => {
  it('parses explicit orphan acknowledgement without coercing false to true', () => {
    expect(DeleteProviderBindingQuerySchema.parse({})).toEqual({
      acknowledgeOrphanedCredential: false
    });
    expect(
      DeleteProviderBindingQuerySchema.parse({ acknowledgeOrphanedCredential: 'false' })
    ).toEqual({ acknowledgeOrphanedCredential: false });
    expect(
      DeleteProviderBindingQuerySchema.parse({ acknowledgeOrphanedCredential: 'true' })
    ).toEqual({ acknowledgeOrphanedCredential: true });
  });

  it('retains a visible pending binding after worker cleanup failure and resumes safely', async () => {
    const { repository, cluster, binding } = await bindingCleanupFixture();
    let calls = 0;
    const agentController = {
      connected: () => true,
      call: async () => {
        calls += 1;
        if (calls === 1) throw new Error('simulated worker cleanup failure');
        return {};
      }
    };

    await expect(
      deleteProviderBindingWithCredentialCleanup({ cluster, agentController }, binding.id, false)
    ).rejects.toThrow('simulated worker cleanup failure');
    await expect(repository.getProviderBinding(binding.id)).resolves.toBeUndefined();
    await expect(
      repository.getProviderBinding(binding.id, { includeDeletionPending: true })
    ).resolves.toMatchObject({ deletionPending: true, state: 'revoked', reachable: false });

    await expect(
      deleteProviderBindingWithCredentialCleanup({ cluster, agentController }, binding.id, false)
    ).resolves.toEqual({
      cleanupMode: 'worker-confirmed',
      nodeId: binding.nodeId,
      orphanAcknowledged: false
    });
    await expect(
      deleteProviderBindingWithCredentialCleanup({ cluster, agentController }, binding.id, false)
    ).resolves.toEqual({ cleanupMode: 'already-finalized', orphanAcknowledged: false });
    expect(calls).toBe(2);
    repository.close();
  });

  it('requires reconnect or revocation and audits explicit orphan acknowledgement', async () => {
    const { repository, cluster, node, binding } = await bindingCleanupFixture();
    const disconnected = { connected: () => false, call: async () => ({}) };
    await expect(
      deleteProviderBindingWithCredentialCleanup(
        { cluster, agentController: disconnected },
        binding.id,
        true
      )
    ).rejects.toThrow('Reconnect the source worker');
    await cluster.revoke(node.id);
    await expect(
      deleteProviderBindingWithCredentialCleanup(
        { cluster, agentController: disconnected },
        binding.id,
        false
      )
    ).rejects.toThrow('acknowledgeOrphanedCredential=true');

    const events: AuditEvent[] = [];
    const audit = new AuditService({
      appendAuditEvent: async (event) => void events.push(event),
      listAuditEvents: async () => events
    });
    const outcome = await auditedOperation(
      audit,
      {
        category: 'provider',
        action: 'provider-binding.delete',
        actor: { type: 'administrator' },
        target: { type: 'provider-binding', id: binding.id },
        context: { orphanAcknowledgementRequested: true },
        success: (result) => ({ context: providerBindingDeletionAuditContext(result) })
      },
      () =>
        deleteProviderBindingWithCredentialCleanup(
          { cluster, agentController: disconnected },
          binding.id,
          true
        )
    );
    expect(outcome).toEqual({
      cleanupMode: 'administrator-acknowledged-orphan',
      nodeId: binding.nodeId,
      orphanAcknowledged: true
    });
    expect(events.at(-1)).toMatchObject({
      outcome: 'success',
      context: {
        orphanAcknowledgementRequested: true,
        cleanupMode: 'administrator-acknowledged-orphan',
        orphanAcknowledged: true,
        nodeId: binding.nodeId
      }
    });
    repository.close();
  });

  it('permits acknowledged finalization when the node record is already absent', async () => {
    const now = new Date().toISOString();
    const value: ProviderBinding = {
      id: 'orphan-binding',
      providerId: 'orphan-provider',
      nodeId: 'missing-node',
      secretRef: 'provider-binding:orphan',
      reachable: false,
      state: 'revoked',
      deletionPending: true,
      lastError: 'cleanup pending',
      validatedAt: null,
      createdAt: now,
      updatedAt: now
    };
    let finalized = false;
    const outcome = await deleteProviderBindingWithCredentialCleanup(
      {
        cluster: {
          beginBindingDeletion: async () => ({ value, revision: 2 }),
          finalizeBindingDeletion: async () => void (finalized = true),
          list: async () => []
        }
      },
      value.id,
      true
    );
    expect(finalized).toBe(true);
    expect(outcome.cleanupMode).toBe('administrator-acknowledged-orphan');
  });
});
