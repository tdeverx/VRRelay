// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBuildIdentity,
  deriveBuildNumber,
  planAssetUploads,
  prepareRelease,
  publishRelease,
  releaseContextFromEnvironment,
  renderReleaseBody,
  validateBuildSequence
} from './publish-rolling-release.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const temporaryDirectories: string[] = [];

function context() {
  const buildId = createBuildIdentity({
    version: '0.1.0',
    buildNumber: '100',
    runId: '987654321',
    runAttempt: '2',
    sha
  });
  return {
    version: '0.1.0',
    buildNumber: '100',
    runId: '987654321',
    runAttempt: '2',
    sha,
    repository: 'example/vrrelay',
    serverUrl: 'https://github.com',
    buildId,
    ociRepository: 'ghcr.io/example/vrrelay',
    ociDigest: `sha256:${'a'.repeat(64)}`
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('rolling release publisher', () => {
  it('creates a collision-safe identity for explicit product build 100', () => {
    expect(context().buildId).toBe('0.1.0-b000100-r987654321-a2-g0123456789ab');
  });

  it('keeps the gate attempt authoritative when only failed jobs are re-run', () => {
    const releaseContext = releaseContextFromEnvironment({
      VRRELAY_VERSION: '0.1.0',
      VRRELAY_BUILD_NUMBER: '100',
      VRRELAY_BUILD_RUN_ATTEMPT: '2',
      GITHUB_RUN_ID: '987654321',
      GITHUB_RUN_ATTEMPT: '3',
      GITHUB_SHA: sha,
      GITHUB_REPOSITORY: 'example/vrrelay'
    });

    expect(releaseContext.runAttempt).toBe('2');
    expect(releaseContext.buildId).toBe('0.1.0-b000100-r987654321-a2-g0123456789ab');
  });

  it.each([
    { buildNumber: '0', runId: '1', runAttempt: '1', sha },
    { buildNumber: '100', runId: 'x', runAttempt: '1', sha },
    { buildNumber: '100', runId: '1', runAttempt: '1', sha: 'abc' }
  ])('rejects an invalid workflow identity', (candidate) => {
    expect(() => createBuildIdentity({ version: '0.1.0', ...candidate })).toThrow();
  });

  it('prepares deterministic checksums and a build manifest', async () => {
    const releaseContext = context();
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-release-'));
    temporaryDirectories.push(directory);
    const names = [
      `VRRelay-${releaseContext.buildId}-macOS-arm64.dmg`,
      `VRRelay-${releaseContext.buildId}-macOS-FFmpeg-source.tar.xz`,
      `VRRelay-${releaseContext.buildId}-Windows-x64.exe`,
      `VRRelay-${releaseContext.buildId}-release-metadata.tar.xz`,
      `VRRelay-${releaseContext.buildId}-FFmpeg-BtbN-source.tar.xz`
    ];
    await Promise.all(
      names.map((name, index) => writeFile(join(directory, name), `asset-${index}\n`))
    );

    const manifest = await prepareRelease(directory, releaseContext);
    const checksumName = `VRRelay-${releaseContext.buildId}-SHA256SUMS`;
    const firstChecksum = await readFile(join(directory, checksumName), 'utf8');
    const secondManifest = await prepareRelease(directory, releaseContext);
    const secondChecksum = await readFile(join(directory, checksumName), 'utf8');

    expect(secondManifest).toEqual(manifest);
    expect(secondChecksum).toBe(firstChecksum);
    expect(manifest.build).toMatchObject({
      id: releaseContext.buildId,
      number: 100,
      runId: 987654321,
      runAttempt: 2,
      commitSha: sha
    });
    expect(manifest.assets.map((asset) => asset.name)).toContain(checksumName);
    expect(JSON.stringify(manifest)).not.toContain('builtAt');
    expect(renderReleaseBody(manifest)).toContain('Current product build: **100**');
  });

  it('reuses only byte-identical assets and never overwrites a collision', () => {
    const local = [{ name: 'build.dmg', size: 7, sha256: 'f'.repeat(64) }];
    expect(
      planAssetUploads(local, [{ name: 'build.dmg', size: 7, digest: `sha256:${'f'.repeat(64)}` }])
    ).toEqual({ uploads: [], reused: local });
    expect(() =>
      planAssetUploads(local, [{ name: 'build.dmg', size: 8, digest: `sha256:${'e'.repeat(64)}` }])
    ).toThrow(/Refusing to overwrite/);
  });

  it('fails closed before GitHub reaches the release asset ceiling', () => {
    expect(() =>
      planAssetUploads(
        [{ name: 'new.dmg', size: 1, sha256: 'f'.repeat(64) }],
        [{ name: 'old.dmg', size: 1, digest: `sha256:${'e'.repeat(64)}` }],
        1
      )
    ).toThrow(/asset budget exceeded/);
  });

  it('removes only a matching incomplete upload before retrying it', async () => {
    const releaseContext = context();
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-release-starter-retry-'));
    temporaryDirectories.push(directory);
    for (const [index, name] of [
      `VRRelay-${releaseContext.buildId}-macOS-arm64.dmg`,
      `VRRelay-${releaseContext.buildId}-macOS-FFmpeg-source.tar.xz`,
      `VRRelay-${releaseContext.buildId}-Windows-x64.exe`,
      `VRRelay-${releaseContext.buildId}-release-metadata.tar.xz`,
      `VRRelay-${releaseContext.buildId}-FFmpeg-BtbN-source.tar.xz`
    ].entries())
      await writeFile(join(directory, name), `asset-${index}\n`);
    await prepareRelease(directory, releaseContext);

    const incompleteName = `VRRelay-${releaseContext.buildId}-macOS-arm64.dmg`;
    const remoteAssets: Array<{
      id: number;
      name: string;
      size: number;
      digest?: string;
      state: string;
    }> = [{ id: 41, name: incompleteName, size: 0, state: 'starter' }];
    const events: string[] = [];
    const client = {
      async getRelease() {
        return { id: 7, tag_name: 'latest', immutable: false };
      },
      async listAssets() {
        return [...remoteAssets];
      },
      async deleteIncompleteAsset(id: number) {
        events.push(`delete-starter:${id}`);
        const index = remoteAssets.findIndex((asset) => asset.id === id);
        remoteAssets.splice(index, 1);
      },
      async uploadAsset(_releaseId: number, asset: { name: string; size: number; sha256: string }) {
        events.push(`upload:${asset.name}`);
        return { size: asset.size, digest: `sha256:${asset.sha256}` };
      },
      async updateRelease() {},
      async updateTag() {}
    };

    await publishRelease(directory, releaseContext, { client });

    expect(events[0]).toBe('delete-starter:41');
    expect(events).toContain(`upload:${incompleteName}`);
    expect(events.filter((event) => event.startsWith('delete-starter:'))).toEqual([
      'delete-starter:41'
    ]);
  });

  it('starts at build 100 and prevents build-number reuse for another commit', () => {
    const releaseContext = context();
    expect(() => validateBuildSequence({ ...releaseContext, buildNumber: '99' }, [])).toThrow(
      /must be product build 100/
    );
    const completed = [
      {
        name: `VRRelay-${releaseContext.buildId}-manifest.json`
      }
    ];
    expect(() => validateBuildSequence(releaseContext, completed)).not.toThrow();
    expect(() =>
      validateBuildSequence({ ...releaseContext, sha: 'f'.repeat(40) }, completed)
    ).toThrow(/different source commit/);
    expect(() =>
      validateBuildSequence({ ...releaseContext, buildNumber: '99' }, completed)
    ).toThrow(/older than completed build 100/);
    expect(() =>
      validateBuildSequence({ ...releaseContext, buildNumber: '102' }, completed)
    ).toThrow(/skips required next build 101/);
  });

  it('derives the next contiguous build number, reuses retries, and ignores incomplete history', () => {
    const completed = [
      {
        name: `VRRelay-0.1.0-b000101-r123-a1-g${sha.slice(0, 12)}-manifest.json`,
        state: 'uploaded'
      },
      {
        name: `VRRelay-0.1.0-b000100-r122-a1-g${'f'.repeat(12)}-manifest.json`,
        state: 'uploaded'
      },
      {
        name: `VRRelay-0.1.0-b000102-r124-a1-g${'e'.repeat(12)}-manifest.json`,
        state: 'starter'
      },
      { name: 'VRRelay-0.1.0-bnot-a-number-r124-a1-gbad-manifest.json', state: 'uploaded' },
      { name: 'unrelated-release-note.txt', state: 'uploaded' }
    ];

    expect(deriveBuildNumber(sha, completed)).toBe('101');
    expect(deriveBuildNumber('a'.repeat(40), completed)).toBe('102');
    expect(deriveBuildNumber('a'.repeat(40), [])).toBe('100');
  });

  it('rejects ambiguous completed build history for the same source commit', () => {
    const completed = [100, 101].map((number) => ({
      name: `VRRelay-0.1.0-b000${number}-r123-a1-g${sha.slice(0, 12)}-manifest.json`,
      state: 'uploaded'
    }));

    expect(() => deriveBuildNumber(sha, completed)).toThrow(/more than one completed/);
  });

  it('does not treat an abandoned starter manifest as completed history', () => {
    const releaseContext = context();
    const abandoned = {
      name: `VRRelay-0.1.0-b000100-r123-a1-g${'f'.repeat(12)}-manifest.json`,
      state: 'starter'
    };

    expect(() => validateBuildSequence(releaseContext, [abandoned])).not.toThrow();
    expect(() =>
      validateBuildSequence(releaseContext, [{ ...abandoned, state: 'uploaded' }])
    ).toThrow(/different source commit/);
  });

  it('commits a build by uploading its manifest last, then advances latest', async () => {
    const releaseContext = context();
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-release-'));
    temporaryDirectories.push(directory);
    for (const [index, name] of [
      `VRRelay-${releaseContext.buildId}-macOS-arm64.dmg`,
      `VRRelay-${releaseContext.buildId}-macOS-FFmpeg-source.tar.xz`,
      `VRRelay-${releaseContext.buildId}-Windows-x64.exe`,
      `VRRelay-${releaseContext.buildId}-release-metadata.tar.xz`,
      `VRRelay-${releaseContext.buildId}-FFmpeg-BtbN-source.tar.xz`
    ].entries())
      await writeFile(join(directory, name), `asset-${index}\n`);
    await prepareRelease(directory, releaseContext);

    const events: string[] = [];
    const client = {
      async getRelease() {
        return { id: 7, tag_name: 'latest', immutable: false };
      },
      async listAssets() {
        return [];
      },
      async uploadAsset(_releaseId: number, asset: { name: string; size: number; sha256: string }) {
        events.push(`upload:${asset.name}`);
        return { size: asset.size, digest: `sha256:${asset.sha256}` };
      },
      async updateRelease() {
        events.push('update-release');
      },
      async updateTag(candidate: string) {
        events.push(`update-tag:${candidate}`);
      }
    };

    await publishRelease(directory, releaseContext, { client });

    const uploadEvents = events.filter((event) => event.startsWith('upload:'));
    expect(uploadEvents.at(-1)).toBe(`upload:VRRelay-${releaseContext.buildId}-manifest.json`);
    expect(events.slice(-2)).toEqual([`update-tag:${sha}`, 'update-release']);
  });

  it('retries a release-body failure without re-uploading completed assets', async () => {
    const releaseContext = context();
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-release-body-retry-'));
    temporaryDirectories.push(directory);
    for (const [index, name] of [
      `VRRelay-${releaseContext.buildId}-macOS-arm64.dmg`,
      `VRRelay-${releaseContext.buildId}-macOS-FFmpeg-source.tar.xz`,
      `VRRelay-${releaseContext.buildId}-Windows-x64.exe`,
      `VRRelay-${releaseContext.buildId}-release-metadata.tar.xz`,
      `VRRelay-${releaseContext.buildId}-FFmpeg-BtbN-source.tar.xz`
    ].entries())
      await writeFile(join(directory, name), `asset-${index}\n`);
    await prepareRelease(directory, releaseContext);

    const events: string[] = [];
    const remoteAssets: Array<{ name: string; size: number; digest: string }> = [];
    let failReleaseUpdate = true;
    const client = {
      async getRelease() {
        return { id: 7, tag_name: 'latest', immutable: false };
      },
      async listAssets() {
        return [...remoteAssets];
      },
      async uploadAsset(_releaseId: number, asset: { name: string; size: number; sha256: string }) {
        events.push(`upload:${asset.name}`);
        const uploaded = { name: asset.name, size: asset.size, digest: `sha256:${asset.sha256}` };
        remoteAssets.push(uploaded);
        return uploaded;
      },
      async updateRelease() {
        events.push('update-release');
        if (failReleaseUpdate) {
          failReleaseUpdate = false;
          throw new Error('simulated release body failure');
        }
      },
      async updateTag(candidate: string) {
        events.push(`update-tag:${candidate}`);
      }
    };

    await expect(publishRelease(directory, releaseContext, { client })).rejects.toThrow(
      'simulated release body failure'
    );
    const uploadCount = events.filter((event) => event.startsWith('upload:')).length;
    expect(events.slice(-2)).toEqual([`update-tag:${sha}`, 'update-release']);

    await expect(publishRelease(directory, releaseContext, { client })).resolves.toMatchObject({
      uploaded: [],
      reused: remoteAssets.map((asset) => asset.name)
    });
    expect(events.filter((event) => event.startsWith('upload:'))).toHaveLength(uploadCount);
    expect(events.slice(-2)).toEqual([`update-tag:${sha}`, 'update-release']);
  });

  it('bootstraps the rolling release using only contents permission', async () => {
    const releaseContext = context();
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-release-'));
    temporaryDirectories.push(directory);
    for (const [index, name] of [
      `VRRelay-${releaseContext.buildId}-macOS-arm64.dmg`,
      `VRRelay-${releaseContext.buildId}-macOS-FFmpeg-source.tar.xz`,
      `VRRelay-${releaseContext.buildId}-Windows-x64.exe`,
      `VRRelay-${releaseContext.buildId}-release-metadata.tar.xz`,
      `VRRelay-${releaseContext.buildId}-FFmpeg-BtbN-source.tar.xz`
    ].entries())
      await writeFile(join(directory, name), `asset-${index}\n`);
    await prepareRelease(directory, releaseContext);

    const events: string[] = [];
    const client = {
      async getRelease() {
        return undefined;
      },
      async getTag() {
        events.push('get-tag');
        return undefined;
      },
      async createTag(candidate: string) {
        events.push(`create-tag:${candidate}`);
      },
      async createRelease(candidate: string) {
        events.push(`create-release:${candidate}`);
        return { id: 7, tag_name: 'latest', immutable: false };
      },
      async listAssets() {
        return [];
      },
      async uploadAsset(_releaseId: number, asset: { name: string; size: number; sha256: string }) {
        return { size: asset.size, digest: `sha256:${asset.sha256}` };
      },
      async updateRelease() {},
      async updateTag() {}
    };

    await publishRelease(directory, releaseContext, { client });

    expect(events).toEqual(['get-tag', `create-tag:${sha}`, `create-release:${sha}`]);
  });
});
