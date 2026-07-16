import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalObjectStore, MemoryCoordinationStore } from './local-infrastructure.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
);

describe('local cloud-neutral infrastructure', () => {
  it('stores opaque keys without exposing them as filesystem paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-objects-'));
    dirs.push(dir);
    const store = new LocalObjectStore(dir);
    const object = await store.put('../provider/source/segment.ts', Readable.from('media'), {
      contentType: 'video/mp2t'
    });
    expect(object.size).toBe(5);
    expect(object.sha256).toBe('721c9525ade2ea8903d343ef25cf68b9bf4ab0aad56bb7b01fbe48d09bc7fcf4');
    const stream = await store.open('../provider/source/segment.ts');
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('media');
    await expect(
      readFile(join(dir, '..', 'provider', 'source', 'segment.ts'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an upload whose expected content hash does not match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-objects-'));
    dirs.push(dir);
    const store = new LocalObjectStore(dir);
    await expect(
      store.put('segment.ts', Readable.from('media'), {
        contentType: 'video/mp2t',
        sha256: '0'.repeat(64)
      })
    ).rejects.toThrow(/hash mismatch/);
    expect(await store.stat('segment.ts')).toBeUndefined();
  });

  it('keeps metadata readable while concurrent readers update access time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-objects-'));
    dirs.push(dir);
    const store = new LocalObjectStore(dir);
    await store.put('shared-segment.ts', Readable.from('media'), {
      contentType: 'video/mp2t'
    });

    for (let round = 0; round < 20; round += 1) {
      const streams = await Promise.all(
        Array.from({ length: 20 }, () => store.open('shared-segment.ts'))
      );
      await Promise.all(
        streams.map(async (stream) => {
          for await (const _chunk of stream!) {
            // Consume the stream so each open exercises the complete reader path.
          }
        })
      );
      await expect(store.stat('shared-segment.ts')).resolves.toMatchObject({ size: 5 });
    }
  });

  it('does not resurrect metadata when an open races with deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-objects-'));
    dirs.push(dir);
    const store = new LocalObjectStore(dir);

    for (let round = 0; round < 20; round += 1) {
      await store.put('shared-segment.ts', Readable.from('media'), {
        contentType: 'video/mp2t'
      });
      const [stream] = await Promise.all([
        store.open('shared-segment.ts'),
        store.delete('shared-segment.ts')
      ]);
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('media');
      await expect(store.stat('shared-segment.ts')).resolves.toBeUndefined();
    }
  });

  it('enforces a single lease owner and propagates pubsub', async () => {
    const coordination = new MemoryCoordinationStore();
    expect(await coordination.acquire('segment:a', 'worker-a', 1000)).toBe(true);
    expect(await coordination.acquire('segment:a', 'worker-b', 1000)).toBe(false);
    const messages: string[] = [];
    const unsubscribe = await coordination.subscribe('revocations', (message) =>
      messages.push(message)
    );
    await coordination.publish('revocations', 'grant-1');
    expect(messages).toEqual(['grant-1']);
    await unsubscribe();
  });

  it('aggregates rolling viewer fingerprints by edge and session', async () => {
    const coordination = new MemoryCoordinationStore();
    await expect(
      coordination.recordViewer({
        sessionId: 'session-1',
        edgeNodeId: 'edge-a',
        viewerHash: 'viewer-a',
        observedAtMs: 30_000,
        windowMs: 30_000
      })
    ).resolves.toEqual({ edgeViewers: 1, totalViewers: 1 });
    await expect(
      coordination.recordViewer({
        sessionId: 'session-1',
        edgeNodeId: 'edge-b',
        viewerHash: 'viewer-b',
        observedAtMs: 31_000,
        windowMs: 30_000
      })
    ).resolves.toEqual({ edgeViewers: 1, totalViewers: 2 });
    await expect(
      coordination.recordViewer({
        sessionId: 'session-1',
        edgeNodeId: 'edge-b',
        viewerHash: 'viewer-a',
        observedAtMs: 32_000,
        windowMs: 30_000
      })
    ).resolves.toEqual({ edgeViewers: 2, totalViewers: 2 });
    await expect(
      coordination.recordViewer({
        sessionId: 'session-1',
        edgeNodeId: 'edge-b',
        viewerHash: 'viewer-b',
        observedAtMs: 62_001,
        windowMs: 30_000
      })
    ).resolves.toEqual({ edgeViewers: 1, totalViewers: 1 });
    await expect(
      coordination.countViewers({
        sessionId: 'session-1',
        observedAtMs: 92_002,
        windowMs: 30_000
      })
    ).resolves.toEqual({ totalViewers: 0 });
  });
});
