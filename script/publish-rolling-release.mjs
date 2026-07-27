// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeReleaseVersion } from './release-version.mjs';

export const rollingReleaseTag = 'latest';
export const rollingReleaseAssetLimit = 900;

function positiveInteger(value, name) {
  const candidate = String(value ?? '');
  if (!/^[1-9]\d*$/.test(candidate)) throw new Error(`${name} must be a positive integer`);
  return candidate;
}

function commitSha(value) {
  const candidate = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(candidate))
    throw new Error('GITHUB_SHA must be a full 40-character commit SHA');
  return candidate;
}

function repositoryName(value) {
  const candidate = String(value ?? '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate))
    throw new Error('GITHUB_REPOSITORY must use the owner/repository form');
  return candidate;
}

function ociRepository(value) {
  const candidate = String(value ?? '');
  if (!/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(candidate))
    throw new Error('VRRELAY_OCI_REPOSITORY must be a lowercase ghcr.io image repository');
  return candidate;
}

function ociDigest(value) {
  const candidate = String(value ?? '').toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(candidate))
    throw new Error('VRRELAY_OCI_DIGEST must be a SHA-256 OCI digest');
  return candidate;
}

export function createBuildIdentity({ version, buildNumber, runId, runAttempt, sha }) {
  const normalizedVersion = normalizeReleaseVersion(version);
  const normalizedBuild = positiveInteger(buildNumber, 'VRRELAY_BUILD_NUMBER');
  const normalizedRunId = positiveInteger(runId, 'GITHUB_RUN_ID');
  const normalizedAttempt = positiveInteger(runAttempt, 'GITHUB_RUN_ATTEMPT');
  const normalizedSha = commitSha(sha);
  const filenameVersion = normalizedVersion.replaceAll('+', '_');
  return `${filenameVersion}-b${normalizedBuild.padStart(6, '0')}-r${normalizedRunId}-a${normalizedAttempt}-g${normalizedSha.slice(0, 12)}`;
}

export function releaseContextFromEnvironment(environment = process.env) {
  const version = normalizeReleaseVersion(environment.VRRELAY_VERSION);
  const buildNumber = positiveInteger(environment.VRRELAY_BUILD_NUMBER, 'VRRELAY_BUILD_NUMBER');
  const runId = positiveInteger(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID');
  const runAttempt = positiveInteger(
    environment.VRRELAY_BUILD_RUN_ATTEMPT ?? environment.GITHUB_RUN_ATTEMPT,
    'VRRELAY_BUILD_RUN_ATTEMPT'
  );
  const sha = commitSha(environment.GITHUB_SHA);
  const repository = repositoryName(environment.GITHUB_REPOSITORY);
  const serverUrl = String(environment.GITHUB_SERVER_URL ?? 'https://github.com').replace(
    /\/$/,
    ''
  );
  if (serverUrl !== 'https://github.com')
    throw new Error('The rolling release publisher supports github.com only');
  return {
    version,
    buildNumber,
    runId,
    runAttempt,
    sha,
    repository,
    serverUrl,
    buildId: createBuildIdentity({ version, buildNumber, runId, runAttempt, sha }),
    ociRepository: environment.VRRELAY_OCI_REPOSITORY
      ? ociRepository(environment.VRRELAY_OCI_REPOSITORY)
      : undefined,
    ociDigest: environment.VRRELAY_OCI_DIGEST
      ? ociDigest(environment.VRRELAY_OCI_DIGEST)
      : undefined
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function describeFile(directory, name) {
  const path = resolve(directory, name);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Release asset must be a regular file: ${name}`);
  return { name, path, size: metadata.size, sha256: await sha256File(path) };
}

function requiredAssetNames(buildId) {
  return [
    `VRRelay-${buildId}-macOS-arm64.dmg`,
    `VRRelay-${buildId}-macOS-FFmpeg-source.tar.xz`,
    `VRRelay-${buildId}-Windows-x64.exe`,
    `VRRelay-${buildId}-release-metadata.tar.xz`,
    `VRRelay-${buildId}-FFmpeg-BtbN-source.tar.xz`
  ];
}

export async function prepareRelease(directory, context) {
  if (!context.ociRepository || !context.ociDigest)
    throw new Error('OCI repository and digest are required to prepare a release');
  const checksumName = `VRRelay-${context.buildId}-SHA256SUMS`;
  const manifestName = `VRRelay-${context.buildId}-manifest.json`;
  const generatedNames = new Set([checksumName, manifestName]);
  const entries = await readdir(directory, { withFileTypes: true });
  const sourceNames = entries
    .filter((entry) => !generatedNames.has(entry.name))
    .map((entry) => {
      if (!entry.isFile()) throw new Error(`Release directory must be flat: ${entry.name}`);
      return entry.name;
    })
    .sort();
  const expectedNames = requiredAssetNames(context.buildId).sort();
  if (
    sourceNames.length !== expectedNames.length ||
    sourceNames.some((name, index) => name !== expectedNames[index])
  )
    throw new Error(
      `Release directory must contain exactly: ${expectedNames.join(', ')}; received: ${sourceNames.join(', ')}`
    );

  const sourceAssets = [];
  for (const name of sourceNames) sourceAssets.push(await describeFile(directory, name));
  const checksums = sourceAssets.map(({ name, sha256 }) => `${sha256}  ${name}`).join('\n');
  await writeFile(resolve(directory, checksumName), `${checksums}\n`, {
    encoding: 'utf8',
    mode: 0o644
  });
  const checksumAsset = await describeFile(directory, checksumName);
  const assets = [...sourceAssets, checksumAsset]
    .map(({ name, size, sha256 }) => ({ name, size, sha256 }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const workflowUrl = `${context.serverUrl}/${context.repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}`;
  const manifest = {
    schemaVersion: 1,
    releaseTag: rollingReleaseTag,
    build: {
      id: context.buildId,
      version: context.version,
      number: Number(context.buildNumber),
      runId: Number(context.runId),
      runAttempt: Number(context.runAttempt),
      commitSha: context.sha,
      workflowUrl
    },
    oci: {
      repository: context.ociRepository,
      digest: context.ociDigest,
      reference: `${context.ociRepository}@${context.ociDigest}`
    },
    assets
  };
  await writeFile(resolve(directory, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644
  });
  return manifest;
}

export function planAssetUploads(localAssets, remoteAssets, assetLimit = rollingReleaseAssetLimit) {
  const remoteByName = new Map(remoteAssets.map((asset) => [asset.name, asset]));
  if (remoteByName.size !== remoteAssets.length)
    throw new Error('The rolling release contains duplicate asset names');
  const uploads = [];
  const reused = [];
  for (const local of localAssets) {
    const remote = remoteByName.get(local.name);
    if (!remote) {
      uploads.push(local);
      continue;
    }
    if (remote.size !== local.size || remote.digest !== `sha256:${local.sha256}`)
      throw new Error(
        `Refusing to overwrite historical release asset ${local.name}; remote digest or size differs`
      );
    reused.push(local);
  }
  if (remoteAssets.length + uploads.length > assetLimit)
    throw new Error(
      `Rolling release asset budget exceeded: ${remoteAssets.length} existing + ${uploads.length} new > ${assetLimit}`
    );
  return { uploads, reused };
}

export function completedBuilds(remoteAssets) {
  return remoteAssets
    .filter((asset) => asset.state === undefined || asset.state === 'uploaded')
    .map((asset) =>
      /^VRRelay-.+-b([0-9]+)-r[0-9]+-a[0-9]+-g([0-9a-f]{12})-manifest\.json$/.exec(asset.name)
    )
    .filter(Boolean)
    .map((match) => ({ number: BigInt(match[1]), shortSha: match[2] }));
}

export function deriveBuildNumber(sha, remoteAssets) {
  const historicalBuilds = completedBuilds(remoteAssets);
  const matchingBuilds = historicalBuilds.filter((build) => build.shortSha === sha.slice(0, 12));
  const matchingNumbers = new Set(matchingBuilds.map((build) => build.number.toString()));
  if (matchingNumbers.size > 1)
    throw new Error('A source commit cannot have more than one completed product build number');
  if (matchingNumbers.size === 1) return [...matchingNumbers][0];
  if (historicalBuilds.length === 0) return '100';
  const highestNumber = historicalBuilds.reduce(
    (highest, build) => (build.number > highest ? build.number : highest),
    0n
  );
  return (highestNumber + 1n).toString();
}

export function validateBuildSequence(context, remoteAssets) {
  const historicalBuilds = completedBuilds(remoteAssets);
  const candidateNumber = BigInt(context.buildNumber);
  if (historicalBuilds.length === 0) {
    if (candidateNumber !== 100n)
      throw new Error('The first rolling release deliverable must be product build 100');
    return;
  }
  const highestNumber = historicalBuilds.reduce(
    (highest, build) => (build.number > highest ? build.number : highest),
    0n
  );
  if (candidateNumber < highestNumber)
    throw new Error(
      `Product build ${candidateNumber} is older than completed build ${highestNumber}`
    );
  if (candidateNumber > highestNumber + 1n)
    throw new Error(
      `Product build ${candidateNumber} skips required next build ${highestNumber + 1n}`
    );
  if (
    candidateNumber === highestNumber &&
    historicalBuilds
      .filter((build) => build.number === candidateNumber)
      .some((build) => build.shortSha !== context.sha.slice(0, 12))
  )
    throw new Error(
      `Product build ${candidateNumber} is already assigned to a different source commit`
    );
}

async function loadPreparedRelease(directory, context) {
  const manifestName = `VRRelay-${context.buildId}-manifest.json`;
  const manifestPath = resolve(directory, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.releaseTag !== rollingReleaseTag ||
    manifest.build?.id !== context.buildId ||
    manifest.build?.commitSha !== context.sha
  )
    throw new Error('Prepared release manifest does not match this workflow build');
  const expectedNames = new Set([...manifest.assets.map((asset) => asset.name), manifestName]);
  const directoryNames = (await readdir(directory)).sort();
  if (
    directoryNames.length !== expectedNames.size ||
    directoryNames.some((name) => !expectedNames.has(name))
  )
    throw new Error('Prepared release directory contains unmanifested files');
  const assets = [];
  for (const expected of manifest.assets) {
    const actual = await describeFile(directory, expected.name);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
      throw new Error(`Prepared release asset changed after manifest creation: ${expected.name}`);
    assets.push(actual);
  }
  assets.push(await describeFile(directory, manifestName));
  return { manifest, assets };
}

function contentType(name) {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.txt') || name.endsWith('SHA256SUMS')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (name.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (name.endsWith('.tar.xz')) return 'application/x-xz';
  return 'application/octet-stream';
}

class GitHubReleaseClient {
  constructor({ token, repository, fetchImplementation = fetch }) {
    if (!token) throw new Error('GITHUB_TOKEN is required to publish the rolling release');
    this.token = token;
    this.repository = repositoryName(repository);
    this.fetch = fetchImplementation;
  }

  async request(
    path,
    {
      method = 'GET',
      body,
      allowed = [200],
      upload = false,
      uploadContentType,
      uploadContentLength
    } = {}
  ) {
    const url = upload
      ? `https://uploads.github.com/repos/${this.repository}${path}`
      : `https://api.github.com/repos/${this.repository}${path}`;
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'vrrelay-rolling-release',
      'X-GitHub-Api-Version': '2026-03-10'
    };
    let requestBody;
    if (body !== undefined && !upload) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body);
    } else {
      requestBody = body;
    }
    if (upload) {
      headers['Content-Type'] = uploadContentType;
      headers['Content-Length'] = String(uploadContentLength);
    }
    const response = await this.fetch(url, {
      method,
      headers,
      body: requestBody,
      ...(upload ? { duplex: 'half' } : {})
    });
    if (!allowed.includes(response.status)) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`GitHub API ${method} ${path} failed with ${response.status}: ${detail}`);
    }
    if (response.status === 404) return undefined;
    if (response.status === 204) return undefined;
    return response.json();
  }

  async getRelease() {
    const direct = await this.request(`/releases/tags/${rollingReleaseTag}`, {
      allowed: [200, 404]
    });
    if (direct) return direct;
    for (let page = 1; ; page += 1) {
      const releases = await this.request(`/releases?per_page=100&page=${page}`);
      const draft = releases.find((release) => release.tag_name === rollingReleaseTag);
      if (draft) return draft;
      if (releases.length < 100) return undefined;
    }
  }

  getTag() {
    return this.request(`/git/ref/tags/${rollingReleaseTag}`, { allowed: [200, 404] });
  }

  createTag(sha) {
    return this.request('/git/refs', {
      method: 'POST',
      allowed: [201],
      body: { ref: `refs/tags/${rollingReleaseTag}`, sha }
    });
  }

  updateTag(sha) {
    return this.request(`/git/refs/tags/${rollingReleaseTag}`, {
      method: 'PATCH',
      body: { sha, force: true }
    });
  }

  createRelease(sha) {
    return this.request('/releases', {
      method: 'POST',
      allowed: [201],
      body: {
        tag_name: rollingReleaseTag,
        target_commitish: sha,
        name: 'Latest VRRelay builds',
        body: 'The first GitHub Actions build is being attached.',
        draft: true,
        prerelease: false
      }
    });
  }

  updateRelease(id, body) {
    return this.request(`/releases/${id}`, {
      method: 'PATCH',
      body: {
        name: 'Latest VRRelay builds',
        body,
        draft: false,
        prerelease: false,
        make_latest: 'true'
      }
    });
  }

  async listAssets(releaseId) {
    const assets = [];
    for (let page = 1; ; page += 1) {
      const next = await this.request(`/releases/${releaseId}/assets?per_page=100&page=${page}`);
      assets.push(...next);
      if (next.length < 100) return assets;
    }
  }

  uploadAsset(releaseId, asset) {
    const query = new URLSearchParams({ name: asset.name });
    return this.request(`/releases/${releaseId}/assets?${query}`, {
      method: 'POST',
      allowed: [201],
      upload: true,
      uploadContentType: contentType(asset.name),
      uploadContentLength: asset.size,
      body: createReadStream(asset.path, { start: 0 })
    });
  }

  deleteIncompleteAsset(assetId) {
    const id = positiveInteger(assetId, 'GitHub release asset id');
    return this.request(`/releases/assets/${id}`, {
      method: 'DELETE',
      allowed: [204]
    });
  }
}

export async function deriveBuildNumberFromEnvironment(environment = process.env) {
  const sha = commitSha(environment.GITHUB_SHA);
  const client = new GitHubReleaseClient({
    token: environment.GITHUB_TOKEN,
    repository: environment.GITHUB_REPOSITORY
  });
  const release = await client.getRelease();
  return deriveBuildNumber(sha, release ? await client.listAssets(release.id) : []);
}

async function ensureRollingRelease(client, sha) {
  let release = await client.getRelease();
  if (release) {
    if (release.tag_name !== rollingReleaseTag)
      throw new Error('GitHub returned a release for an unexpected tag');
    if (release.immutable)
      throw new Error('The latest release is immutable and cannot accept historical build assets');
    return release;
  }
  const tag = await client.getTag();
  if (!tag) await client.createTag(sha);
  release = await client.createRelease(sha);
  if (release.immutable)
    throw new Error('The latest release is immutable and cannot accept historical build assets');
  return release;
}

export function renderReleaseBody(manifest) {
  const downloadBase = `${manifest.build.workflowUrl.split('/actions/runs/')[0]}/releases/download/${rollingReleaseTag}`;
  const artifactLines = manifest.assets
    .filter((asset) => !asset.name.endsWith('SHA256SUMS'))
    .map(
      (asset) =>
        `- [${asset.name}](${downloadBase}/${encodeURIComponent(asset.name)}) — \`${asset.sha256}\``
    );
  return [
    '# Latest VRRelay build',
    '',
    `Current product build: **${manifest.build.number}** (\`${manifest.build.id}\`)`,
    '',
    `Commit: [\`${manifest.build.commitSha}\`](${manifest.build.workflowUrl.split('/actions/runs/')[0]}/commit/${manifest.build.commitSha})`,
    '',
    `Authoritative workflow: [run ${manifest.build.runId}, attempt ${manifest.build.runAttempt}](${manifest.build.workflowUrl})`,
    '',
    `OCI image: \`${manifest.oci.reference}\``,
    '',
    '## Current build assets',
    '',
    ...artifactLines,
    '',
    `Checksums: [VRRelay-${manifest.build.id}-SHA256SUMS](${downloadBase}/VRRelay-${manifest.build.id}-SHA256SUMS)`,
    '',
    `Manifest: [VRRelay-${manifest.build.id}-manifest.json](${downloadBase}/VRRelay-${manifest.build.id}-manifest.json)`,
    '',
    '## Historical builds',
    '',
    'Every build remains attached below under its build-numbered name. Assets are never overwritten; use the matching manifest and checksum file to verify a historical build.'
  ].join('\n');
}

export async function publishRelease(directory, context, options = {}) {
  const prepared = await loadPreparedRelease(directory, context);
  const client =
    options.client ??
    new GitHubReleaseClient({
      token: options.token ?? process.env.GITHUB_TOKEN,
      repository: context.repository
    });
  const release = await ensureRollingRelease(client, context.sha);
  let remoteAssets = await client.listAssets(release.id);
  const localNames = new Set(prepared.assets.map((asset) => asset.name));
  const incompleteRetryAssets = remoteAssets.filter(
    (asset) => asset.state === 'starter' && localNames.has(asset.name)
  );
  for (const asset of incompleteRetryAssets) await client.deleteIncompleteAsset(asset.id);
  if (incompleteRetryAssets.length > 0) remoteAssets = await client.listAssets(release.id);
  validateBuildSequence(context, remoteAssets);
  const plan = planAssetUploads(prepared.assets, remoteAssets);
  for (const asset of plan.uploads) {
    const uploaded = await client.uploadAsset(release.id, asset);
    if (uploaded.size !== asset.size || uploaded.digest !== `sha256:${asset.sha256}`)
      throw new Error(`GitHub did not confirm the expected digest for ${asset.name}`);
  }
  await client.updateTag(context.sha);
  await client.updateRelease(release.id, renderReleaseBody(prepared.manifest));
  return {
    releaseId: release.id,
    uploaded: plan.uploads.map((asset) => asset.name),
    reused: plan.reused.map((asset) => asset.name)
  };
}

async function main() {
  const command = process.argv[2];
  if (command === 'next-build-number') {
    process.stdout.write(`${await deriveBuildNumberFromEnvironment()}\n`);
    return;
  }
  const context = releaseContextFromEnvironment();
  if (command === 'identity') {
    process.stdout.write(`${context.buildId}\n`);
    return;
  }
  const directory = resolve(process.argv[3] ?? 'artifacts');
  if (command === 'prepare') {
    const manifest = await prepareRelease(directory, context);
    process.stdout.write(`${manifest.build.id}\n`);
    return;
  }
  if (command === 'publish') {
    const result = await publishRelease(directory, context);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(
    'Usage: node script/publish-rolling-release.mjs identity|next-build-number|prepare [artifact-directory]|publish [artifact-directory]'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
