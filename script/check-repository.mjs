// SPDX-License-Identifier: GPL-3.0-or-later
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const excludedDirectories = new Set([
  '.git',
  '.cache',
  '.data',
  '.svelte-kit',
  'build',
  'dist',
  'node_modules'
]);

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}

const repositoryFiles = await files(root);
const failures = [];

for (const required of [
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'GOVERNANCE.md',
  'LICENSE',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/public-release-checklist.md',
  '.github/dependabot.yml',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml'
]) {
  try {
    await access(resolve(root, required));
  } catch {
    failures.push(`public repository metadata is missing ${required}`);
  }
}

for (const markdown of repositoryFiles.filter((path) => path.endsWith('.md'))) {
  const content = await readFile(markdown, 'utf8');
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]?.split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    try {
      await access(resolve(dirname(markdown), decodeURIComponent(target)));
    } catch {
      failures.push(`${relative(root, markdown)} links to missing ${target}`);
    }
  }
}

const routeSources = await Promise.all(
  ['apps/relay/src/server.ts', 'apps/relay/src/agent-transport.ts'].map((path) =>
    readFile(resolve(root, path), 'utf8')
  )
);
const runtimeRoutes = new Set();
for (const match of routeSources[0].matchAll(
  /app\.(get|post|patch|delete)\(\s*['`]\/api\/v1([^'`]+)['`]/g
)) {
  const method = match[1]?.toUpperCase();
  const path = match[2]?.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
  if (method && path) runtimeRoutes.add(`${method} ${path}`);
}
if (routeSources[1].includes("'/api/v1/nodes/connect'")) runtimeRoutes.add('GET /nodes/connect');

const openapi = await readFile(resolve(root, 'contracts/openapi/vrrelay-v1.yaml'), 'utf8');
const documentedRoutes = new Set();
let currentPath;
for (const line of openapi.split('\n')) {
  const path = /^  (\/[^:]+):$/.exec(line);
  if (path) {
    currentPath = path[1];
    continue;
  }
  const method = /^    (get|post|patch|delete):$/.exec(line);
  if (currentPath && method) documentedRoutes.add(`${method[1].toUpperCase()} ${currentPath}`);
}
for (const route of runtimeRoutes) {
  if (!documentedRoutes.has(route)) failures.push(`OpenAPI is missing runtime route ${route}`);
}
for (const route of documentedRoutes) {
  if (!runtimeRoutes.has(route)) failures.push(`OpenAPI documents absent runtime route ${route}`);
}

for (const workflow of repositoryFiles.filter((path) => path.includes('/.github/workflows/'))) {
  const content = await readFile(workflow, 'utf8');
  for (const match of content.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)) {
    if (!/^[a-f0-9]{40}$/.test(match[2] ?? ''))
      failures.push(`${relative(root, workflow)} uses unpinned action ${match[1]}@${match[2]}`);
  }
}
for (const workflow of repositoryFiles.filter((path) => path.includes('/.github/workflows/'))) {
  const content = await readFile(workflow, 'utf8');
  if (content.includes('azure/setup-helm@') && !content.includes('version: v4.2.3'))
    failures.push(`${relative(root, workflow)} does not pin the Helm CLI version`);
}

const multiHostCompose = await readFile(
  resolve(root, 'deploy/docker/compose.multi-host.yml'),
  'utf8'
);
for (const required of [
  'mediamtx-origin:',
  'mediamtx-edge:',
  'VRRELAY_LIVE_ORIGIN_URL:',
  'VRRELAY_MEDIAMTX_HLS_URL: http://mediamtx-edge:8888'
]) {
  if (!multiHostCompose.includes(required))
    failures.push(`multi-host Compose is missing ${required}`);
}
const edgeService =
  /\n  edge:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]+:\n)/.exec(multiHostCompose)?.[1] ?? '';
if (/ports:[^\n]*8888/.test(edgeService))
  failures.push('multi-host edge exposes MediaMTX HLS instead of the authorized relay');

for (const path of ['deploy/docker/docker-compose.cluster.yml', 'deploy/integration/compose.yml']) {
  const compose = await readFile(resolve(root, path), 'utf8');
  if (compose.includes('entrypoint: [/bin/sh, -c]'))
    failures.push(`${path} passes a split command to sh -c instead of one script argument`);
  if (!compose.includes('mc anonymous set private'))
    failures.push(`${path} does not explicitly keep the object bucket private`);
}

const releaseWorkflow = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8');
for (const required of [
  'npm run test:local-cluster',
  'npm run test:integration',
  'node script/check-kubernetes.mjs rendered.yaml',
  'aquasecurity/trivy-action@',
  'needs: [gate, security]'
]) {
  if (!releaseWorkflow.includes(required))
    failures.push(`release workflow is missing required gate: ${required}`);
}
if (!releaseWorkflow.includes('permissions: { contents: read }'))
  failures.push('release workflow does not default jobs to read-only repository access');

const securityPolicy = await readFile(resolve(root, 'SECURITY.md'), 'utf8');
for (const required of [
  'Report a vulnerability',
  "GitHub's **Security → Report a vulnerability** flow",
  'Do not open a public issue'
]) {
  if (!securityPolicy.includes(required))
    failures.push(`security policy is missing private-reporting guidance: ${required}`);
}
const bugTemplate = await readFile(resolve(root, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8');
for (const required of ['Do not include credentials', 'This is not a security report']) {
  if (!bugTemplate.includes(required))
    failures.push(`bug template is missing security hygiene prompt: ${required}`);
}
const publicReleaseChecklist = await readFile(
  resolve(root, 'docs/public-release-checklist.md'),
  'utf8'
);
for (const required of [
  'secret scanning',
  'push protection',
  'Dependabot alerts',
  'private vulnerability reporting',
  'code scanning',
  'Protect `main`',
  'Restrict tag creation'
]) {
  if (!publicReleaseChecklist.includes(required))
    failures.push(`public release checklist is missing repository gate: ${required}`);
}
const dependabot = await readFile(resolve(root, '.github/dependabot.yml'), 'utf8');
for (const required of [
  'package-ecosystem: npm',
  'package-ecosystem: github-actions',
  'package-ecosystem: docker'
]) {
  if (!dependabot.includes(required)) failures.push(`Dependabot config is missing ${required}`);
}

const ciWorkflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
for (const required of [
  'docker/setup-qemu-action@',
  'platforms: linux/amd64,linux/arm64',
  'script/check-workflows.sh',
  'script/check-compose.sh',
  'script/container-smoke.sh 0.0.0-ci',
  'script/compose-smoke.sh'
]) {
  if (!ciWorkflow.includes(required))
    failures.push(`CI multi-architecture build is missing ${required}`);
}
if (!releaseWorkflow.includes('script/check-compose.sh'))
  failures.push('release workflow does not validate every Compose deployment');
if (!releaseWorkflow.includes('script/container-smoke.sh'))
  failures.push('release workflow does not boot and verify the release container');
if (!releaseWorkflow.includes('script/compose-smoke.sh'))
  failures.push('release workflow does not boot and verify standalone Compose');
if (/^\s+linux\/arm64:\s*$/m.test(ciWorkflow))
  failures.push(
    'CI treats linux/arm64 as an invalid build-action input instead of a platform value'
  );
const macosPackageScript = await readFile(resolve(root, 'deploy/macos/package.sh'), 'utf8');
if (!macosPackageScript.includes('script/verify-macos-package.sh'))
  failures.push('macOS packaging does not verify the completed installer payload');
for (const required of [
  'script/release-version.mjs',
  'build-args: VRRELAY_VERSION=',
  'VRRELAY_FFMPEG_SOURCE_BUNDLE_URL',
  'ffmpeg-btbn-corresponding-source.tar.xz',
  'script/windows-source-bundle.mjs --verify',
  "pattern: 'vrrelay-*'",
  'draft: true',
  'VRRelay-release-metadata-SHA256SUMS',
  'docs/releasing.md'
]) {
  if (!releaseWorkflow.includes(required))
    failures.push(`release workflow does not enforce release metadata ${required}`);
}

const dockerfile = await readFile(resolve(root, 'deploy/docker/Dockerfile'), 'utf8');
for (const required of [
  'ARG VRRELAY_VERSION',
  'org.opencontainers.image.version',
  'VRRELAY_VERSION=$VRRELAY_VERSION'
]) {
  if (!dockerfile.includes(required)) failures.push(`OCI image does not propagate ${required}`);
}
if (dockerfile.includes('apt-get install -y --no-install-recommends ffmpeg'))
  failures.push('OCI image falls back to the unpinned distribution FFmpeg package');
const helmValues = await readFile(resolve(root, 'deploy/kubernetes/values.yaml'), 'utf8');
const helmTemplates = await Promise.all(
  ['deploy/kubernetes/templates/runtime.yaml', 'deploy/kubernetes/templates/migrate.yaml'].map(
    (path) => readFile(resolve(root, path), 'utf8')
  )
);
if (!/tag:\s*['"]{2}/.test(helmValues))
  failures.push('Helm image tag must default to the packaged chart appVersion');
for (const template of helmTemplates) {
  if (!template.includes('.Chart.AppVersion'))
    failures.push('Helm workload does not fall back to the packaged chart appVersion');
}

const versionedSources = await Promise.all(
  [
    'apps/relay/src/server.ts',
    'apps/web/src/lib/components/AppShell.svelte',
    'apps/web/src/routes/compatibility/+page.svelte'
  ].map((path) => readFile(resolve(root, path), 'utf8'))
);
for (const source of versionedSources) {
  if (source.includes("'0.1.0'") || source.includes('v0.1.0'))
    failures.push('runtime or dashboard contains a hard-coded application version');
}

const runtimeManifest = JSON.parse(
  await readFile(resolve(root, 'deploy/runtime-manifest.json'), 'utf8')
);
const runtimeComponents = new Map(
  runtimeManifest.components.map((component) => [component.name, component])
);
if (!dockerfile.includes(`node:${runtimeComponents.get('node')?.version}-bookworm-slim`))
  failures.push('OCI image Node base differs from the pinned runtime manifest');
for (const component of runtimeComponents.values()) {
  if (!component.version || !component.license || !component.source)
    failures.push(`runtime component ${component.name} lacks version, license, or source`);
  for (const artifact of Object.values(component.artifacts ?? {})) {
    if (!artifact.file || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? ''))
      failures.push(`runtime component ${component.name} contains an invalid artifact pin`);
  }
}
const ffmpegWindows = runtimeComponents.get('ffmpeg')?.artifacts?.['windows-x64'];
const ffmpegLinux = ['linux-x64', 'linux-arm64'].map(
  (target) => runtimeComponents.get('ffmpeg')?.artifacts?.[target]
);
for (const required of [
  'provider',
  'releaseTag',
  'repositoryCommit',
  'ffmpegCommit',
  'target',
  'variant',
  'addins'
]) {
  if (ffmpegWindows && !(required in (ffmpegWindows.buildRecipe ?? {})))
    failures.push(`Windows FFmpeg runtime lacks build recipe field ${required}`);
}
const sourceBuilder = await readFile(
  resolve(root, 'deploy/windows/build-corresponding-source.sh'),
  'utf8'
);
for (const value of Object.values(ffmpegWindows?.buildRecipe ?? {}).flat()) {
  if (typeof value === 'string' && !sourceBuilder.includes(value))
    failures.push(`Windows source builder does not consume pinned recipe value ${value}`);
}
for (const artifact of ffmpegLinux) {
  if (!artifact?.file || !artifact?.sha256 || !artifact?.buildRecipe)
    failures.push('OCI FFmpeg runtime lacks a pinned artifact and build recipe');
  for (const required of [artifact?.file, artifact?.sha256]) {
    if (required && !dockerfile.includes(required))
      failures.push(`OCI image does not consume pinned FFmpeg runtime ${required}`);
  }
  for (const value of Object.values(artifact?.buildRecipe ?? {}).flat()) {
    if (typeof value === 'string' && !sourceBuilder.includes(value))
      failures.push(`FFmpeg source builder does not cover Linux recipe value ${value}`);
  }
}
const windowsPackage = JSON.parse(
  await readFile(resolve(root, 'apps/windows/package.json'), 'utf8')
);
if (windowsPackage.devDependencies?.electron !== runtimeComponents.get('electron')?.version)
  failures.push('Windows Electron build dependency differs from the bundled runtime manifest');
const windowsPackager = await readFile(resolve(root, 'deploy/windows/package.ps1'), 'utf8');
for (const required of [
  runtimeComponents.get('electron')?.version,
  runtimeComponents.get('ffmpeg')?.artifacts?.['windows-x64']?.file,
  'runtime-provenance.mjs'
]) {
  if (required && !windowsPackager.includes(required))
    failures.push(`Windows packager does not consume pinned runtime ${required}`);
}
for (const required of ['release-version.mjs', 'VRRELAY_VERSION', '__VRRELAY_VERSION__']) {
  if (!windowsPackager.includes(required))
    failures.push(`Windows packager does not propagate release version through ${required}`);
}
const macPackager = await readFile(resolve(root, 'deploy/macos/package.sh'), 'utf8');
for (const required of ['release-version.mjs', 'CFBundleShortVersionString', 'VRRELAY_VERSION']) {
  if (!macPackager.includes(required))
    failures.push(`macOS packager does not propagate release version through ${required}`);
}
if (!releaseWorkflow.includes('brew install ffmpeg@7'))
  failures.push('release workflow does not install the pinned macOS FFmpeg formula');
if (/choco install ffmpeg/.test(releaseWorkflow))
  failures.push('release workflow installs an unpinned Chocolatey FFmpeg package');

const macService = await readFile(
  resolve(root, 'apps/macos/Sources/VRRelayMac/RelayService.swift'),
  'utf8'
);
const macViews = await readFile(resolve(root, 'apps/macos/Sources/VRRelayMac/Views.swift'), 'utf8');
if (!macService.includes('system/org.vrrelay.service'))
  failures.push('macOS host does not control the packaged system LaunchDaemon');
for (const forbidden of ['Library/LaunchAgents', 'gui/', '/Users/admin/Documents/VRR']) {
  if (`${macService}\n${macViews}`.includes(forbidden))
    failures.push(`macOS host contains development-only service path ${forbidden}`);
}
if (macViews.includes('repositoryPath'))
  failures.push('macOS settings expose the removed developer repository path');

const nativeServiceFiles = await Promise.all(
  ['deploy/macos/org.vrrelay.service.plist', 'deploy/windows/VRRelay.xml'].map((path) =>
    readFile(resolve(root, path), 'utf8')
  )
);
for (const [index, service] of nativeServiceFiles.entries()) {
  for (const required of [
    'VRRELAY_MEDIAMTX_EXECUTABLE',
    'VRRELAY_MEDIAMTX_CONFIG',
    'VRRELAY_MEDIAMTX_ALLOW_INTERNAL_READ'
  ]) {
    if (!service.includes(required))
      failures.push(
        `${index === 0 ? 'macOS' : 'Windows'} native service does not configure ${required}`
      );
  }
}
for (const packaging of ['deploy/macos/package.sh', 'deploy/windows/package.ps1']) {
  if (!/deploy[\\/]native/.test(await readFile(resolve(root, packaging), 'utf8')))
    failures.push(`${packaging} does not bundle the native MediaMTX configuration`);
}

const forbiddenFixtures = [['192', '168', '0', '18'].join('.'), `testing${123}`];
for (const path of repositoryFiles.filter(
  (candidate) =>
    !candidate.includes('/apps/relay/public/') &&
    !candidate.includes('/apps/web/src/lib/generated/') &&
    !candidate.endsWith('package-lock.json') &&
    !/\.(?:png|jpg|jpeg|webp|ico)$/.test(candidate)
)) {
  const content = await readFile(path, 'utf8').catch(() => '');
  for (const value of forbiddenFixtures) {
    if (content.includes(value))
      failures.push(`${relative(root, path)} contains private fixture ${value}`);
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(
  `Repository checks passed (${documentedRoutes.size} API operations, ${repositoryFiles.filter((path) => path.endsWith('.md')).length} Markdown files).`
);
