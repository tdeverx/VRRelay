// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { SqliteRepository } from '@vrrelay/adapters';
import { AuthService } from './auth.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function bearer(token: string): FastifyRequest {
  return {
    cookies: {},
    headers: { authorization: `Bearer ${token}` }
  } as FastifyRequest;
}

describe('personal access tokens', () => {
  it('returns the complete public record, records use, enforces scopes, and revokes access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const auth = new AuthService(repository);

    const created = await auth.createPersonalToken('Test client', ['sessions:read'], null);
    expect(created).toMatchObject({
      name: 'Test client',
      scopes: ['sessions:read'],
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null
    });
    expect(created.token).toMatch(/^vrr_/);
    expect(JSON.stringify(created)).not.toContain('tokenHash');

    await expect(
      auth.authenticate(bearer(created.token), ['sessions:read'])
    ).resolves.toMatchObject({
      kind: 'personal_token'
    });
    await expect(auth.authenticate(bearer(created.token), ['sessions:control'])).rejects.toThrow(
      'required scope'
    );
    expect((await auth.listPersonalTokens())[0]?.lastUsedAt).not.toBeNull();

    await auth.revokePersonalToken(created.id);
    await expect(auth.authenticate(bearer(created.token), ['sessions:read'])).rejects.toThrow(
      'Authentication is required'
    );
    repository.close();
  });
});
