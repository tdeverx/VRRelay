// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { EnrollNodeRequestSchema } from './index.js';

const capabilities = {
  encoders: [],
  hardwareDevices: [],
  maxWorkers: 1,
  activeWorkers: 0,
  queuedWorkers: 0,
  cacheBytes: 0,
  cacheLimitBytes: null,
  egressMbps: 0,
  providerIds: []
};

describe('node enrollment contract', () => {
  it('accepts only HTTP(S) routing URLs', () => {
    const base = {
      token: 'x'.repeat(32),
      name: 'Edge',
      capabilities
    };
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'https://edge.example' }).success
    ).toBe(true);
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'javascript:alert(1)' }).success
    ).toBe(false);
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'ftp://edge.example' }).success
    ).toBe(false);
    expect(
      EnrollNodeRequestSchema.safeParse({
        ...base,
        publicUrl: 'https://user:password@edge.example'
      }).success
    ).toBe(false);
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'https://edge.example?token=x' })
        .success
    ).toBe(false);
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'https://edge.example#fragment' })
        .success
    ).toBe(false);
  });
});
