// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AgentEnvelopeSchema, type AgentEnvelope } from './agent-protocol.js';

const capabilities = {
  encoders: ['libx264'],
  hardwareDevices: [],
  maxWorkers: 2,
  activeWorkers: 0,
  queuedWorkers: 0,
  cacheBytes: 0,
  cacheLimitBytes: null,
  egressMbps: 0,
  providerIds: []
};

const certificate = {
  certificatePem: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----',
  caCertificatePem: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----',
  expiresAt: '2030-01-01T00:00:00.000Z',
  serialNumber: '01',
  fingerprintSha256: 'a'.repeat(64)
};

const payloads: Array<readonly [AgentEnvelope['kind'], Record<string, unknown>]> = [
  ['hello', { nodeId: 'node-1', capabilities, draining: false }],
  ['heartbeat', { capabilities, draining: false }],
  ['capabilities', { capabilities, draining: true }],
  [
    'job.offer',
    { jobId: 'job-1', sessionId: 'session-1', contentKey: 'vod/0.ts', segmentIndex: 0 }
  ],
  ['job.accept', { ok: true, jobId: 'job-1' }],
  [
    'job.reject',
    {
      ok: false,
      jobId: 'job-1',
      error: { code: 'busy', message: 'Busy', retryable: true }
    }
  ],
  ['job.progress', { ok: true, jobId: 'job-1', state: 'running' }],
  ['job.progress', { action: 'ensure', token: 'grant', segmentIndex: 0 }],
  ['job.complete', { ok: true, jobId: 'job-1' }],
  [
    'job.fail',
    {
      ok: false,
      jobId: 'job-1',
      error: { code: 'failed', message: 'Failed', retryable: false }
    }
  ],
  ['job.cancel', { jobId: 'job-1' }],
  ['cache.inventory', {}],
  ['cache.evict', { all: true }],
  ['cache.evict', { sessionId: 'session-1' }],
  ['cache.evict', { profileId: 'profile-1' }],
  ['drain', { draining: true }],
  ['certificate.rotate', { reason: 'administrative' }],
  ['certificate.rotate', { csrPem: '-----BEGIN CERTIFICATE REQUEST-----' }],
  ['certificate.rotated', { ok: true, certificate }],
  ['log', { level: 'info', message: 'Ready', context: { attempt: 1 } }],
  ['response', { ok: true, result: { saved: true } }],
  [
    'error',
    {
      ok: false,
      error: { code: 'invalid', message: 'Invalid request', retryable: false }
    }
  ],
  [
    'provider.bind',
    {
      nodeId: 'node-1',
      providerId: 'provider-1',
      bindingId: 'binding-1',
      creationMode: 'new',
      expectedProviderRevision: null,
      input: {
        nodeId: 'node-1',
        type: 'jellyfin',
        name: 'Media',
        baseUrl: 'https://media.example',
        allowPublicHttp: false,
        authMode: 'api_key',
        apiKey: 'fixture-api-key'
      }
    }
  ],
  ['provider.unbind', { bindingId: 'binding-1' }],
  [
    'provider.browse',
    {
      providerId: 'provider-1',
      query: { kinds: [], limit: 50, offset: 0 }
    }
  ],
  ['provider.item', { providerId: 'provider-1', itemId: 'item-1' }],
  ['provider.validate', { providerId: 'provider-1' }],
  [
    'provider.activity',
    {
      providerId: 'provider-1',
      sessionId: 'session-1',
      itemId: 'item-1',
      positionTicks: 0,
      paused: false,
      event: 'start'
    }
  ]
];

function envelope(kind: AgentEnvelope['kind'], payload: Record<string, unknown>) {
  return {
    version: 1,
    id: 'message-1',
    sequence: 1,
    kind,
    sentAt: '2026-07-15T00:00:00.000Z',
    payload
  };
}

describe('strict agent protocol', () => {
  it.each(payloads)('accepts the current %s payload', (kind, payload) => {
    expect(AgentEnvelopeSchema.safeParse(envelope(kind, payload)).success).toBe(true);
  });

  it.each(payloads)('rejects unknown fields in the %s payload', (kind, payload) => {
    expect(
      AgentEnvelopeSchema.safeParse(envelope(kind, { ...payload, unexpected: true })).success
    ).toBe(false);
  });

  it('rejects loose legacy success and error shapes', () => {
    expect(
      AgentEnvelopeSchema.safeParse(envelope('response', { ok: true, arbitrary: 'value' })).success
    ).toBe(false);
    expect(
      AgentEnvelopeSchema.safeParse(envelope('error', { ok: false, message: 'failed' })).success
    ).toBe(false);
  });

  it('rejects unknown capability fields and unbounded log context', () => {
    expect(
      AgentEnvelopeSchema.safeParse(
        envelope('heartbeat', {
          capabilities: { ...capabilities, unexpected: true },
          draining: false
        })
      ).success
    ).toBe(false);
    expect(
      AgentEnvelopeSchema.safeParse(
        envelope('log', {
          level: 'info',
          message: 'too many values',
          context: { values: Array.from({ length: 101 }, () => 1) }
        })
      ).success
    ).toBe(false);
  });
});
