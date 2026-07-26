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
  'node_modules',
  'tmp'
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
const repositoryRelativeFiles = new Set(repositoryFiles.map((path) => relative(root, path)));
const failures = [];
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const rootLock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));

if (rootPackage.devDependencies?.['typescript-compat'] !== 'npm:@typescript/typescript6@6.0.2')
  failures.push('TypeScript API tooling must use the official TypeScript 6 compatibility package');
if (rootPackage.overrides?.['@sveltejs/kit']?.cookie !== '$cookie')
  failures.push('SvelteKit must share the root API-compatible Cookie security release');
if (rootPackage.devDependencies?.cookie !== '2.0.1')
  failures.push('the root Cookie declaration must anchor SvelteKit 3 compatibility at 2.0.1');
for (const consumer of ['gaxios', 'teeny-request']) {
  if (rootPackage.overrides?.[consumer]?.uuid !== '14.0.1')
    failures.push(`${consumer} must use the patched UUID 14 security override`);
}
for (const removed of ['eslint-config-prettier', 'uuid']) {
  if (rootPackage.dependencies?.[removed] || rootPackage.devDependencies?.[removed])
    failures.push(`root package must not restore unused dependency ${removed}`);
}
if ((rootPackage.workspaces ?? []).includes('apps/windows'))
  failures.push('the native Windows controller must not be restored as an npm workspace');
for (const nativeTarget of [
  '@node-rs/argon2-linux-x64-gnu',
  '@node-rs/argon2-win32-x64-msvc',
  '@tailwindcss/oxide-linux-x64-gnu',
  '@tailwindcss/oxide-win32-x64-msvc'
]) {
  if (!rootLock.packages?.[`node_modules/${nativeTarget}`])
    failures.push(`package lock must retain cross-platform optional target ${nativeTarget}`);
}

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

const gitignore = await readFile(resolve(root, '.gitignore'), 'utf8');
for (const required of [
  '.env.*',
  '!.env.example',
  '**/.terraform/',
  '*.tfstate',
  '*.tfvars',
  '*.p12',
  '*.pem',
  '*.sqlite',
  '*.mp4'
]) {
  if (!gitignore.split('\n').includes(required))
    failures.push(`.gitignore is missing sensitive local pattern ${required}`);
}

const dockerignore = await readFile(resolve(root, '.dockerignore'), 'utf8');
for (const required of ['.env.*', '.codex', 'tmp', '**/.terraform', '*.tfstate', '*.tfvars']) {
  if (!dockerignore.split('\n').includes(required))
    failures.push(`.dockerignore is missing sensitive build-context pattern ${required}`);
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
  [
    'apps/relay/src/server.ts',
    'apps/relay/src/composition/role-server.ts',
    'apps/relay/src/agent-transport.ts'
  ].map((path) => readFile(resolve(root, path), 'utf8'))
);
const runtimeRoutes = new Set();
for (const source of routeSources.slice(0, 2)) {
  for (const match of source.matchAll(
    /app\.(get|post|put|patch|delete)\(\s*['`]\/api\/v1([^'`]+)['`]/g
  )) {
    const method = match[1]?.toUpperCase();
    const path = match[2]?.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
    if (method && path) runtimeRoutes.add(`${method} ${path}`);
  }
}
if (routeSources[2].includes("'/api/v1/nodes/connect'")) runtimeRoutes.add('GET /nodes/connect');

const openapi = await readFile(resolve(root, 'contracts/openapi/vrrelay-v1.yaml'), 'utf8');
const documentedRoutes = new Set();
let currentPath;
for (const line of openapi.split('\n')) {
  const path = /^  (\/[^:]+):$/.exec(line);
  if (path) {
    currentPath = path[1];
    continue;
  }
  const method = /^    (get|post|put|patch|delete):$/.exec(line);
  if (currentPath && method) documentedRoutes.add(`${method[1].toUpperCase()} ${currentPath}`);
}
for (const route of runtimeRoutes) {
  if (!documentedRoutes.has(route)) failures.push(`OpenAPI is missing runtime route ${route}`);
}
for (const route of documentedRoutes) {
  if (!runtimeRoutes.has(route)) failures.push(`OpenAPI documents absent runtime route ${route}`);
}

const webApiFacade = await readFile(resolve(root, 'apps/web/src/lib/api.ts'), 'utf8');
if (!webApiFacade.includes('#lib/generated/vrrelay-api/sdk.gen'))
  failures.push('web API facade does not use generated OpenAPI operations');
if (webApiFacade.includes('generatedClient.request('))
  failures.push('web API facade bypasses generated OpenAPI operations with a handwritten request');
if (webApiFacade.includes('/api/v1/'))
  failures.push('web API facade owns a handwritten API path instead of a generated operation');

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
  'npx playwright install --with-deps chromium',
  'npm run test:browser',
  'node script/check-kubernetes.mjs rendered.yaml',
  'aquasecurity/trivy-action@',
  'needs: [gate, security]'
]) {
  if (!releaseWorkflow.includes(required))
    failures.push(`release workflow is missing required gate: ${required}`);
}
if (!releaseWorkflow.includes('permissions: { contents: read }'))
  failures.push('release workflow does not default jobs to read-only repository access');
if ((releaseWorkflow.match(/overwrite: true/g) ?? []).length !== 4)
  failures.push('release workflow must replace all four transient handoff artifacts on job retry');

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
const integrationWorkflow = await readFile(
  resolve(root, '.github/workflows/integration.yml'),
  'utf8'
);
for (const required of [
  'docker/setup-qemu-action@',
  'platforms: linux/amd64,linux/arm64',
  'script/install-pinned-ffmpeg-windows.ps1',
  '/Applications/Xcode_26.6.app',
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
for (const [name, workflow] of [
  ['CI', ciWorkflow],
  ['distributed acceptance', integrationWorkflow],
  ['release', releaseWorkflow]
]) {
  if (!workflow.includes('script/install-pinned-ffmpeg-linux.sh'))
    failures.push(`${name} workflow does not install the pinned Linux FFmpeg runtime`);
}
if (/^\s+linux\/arm64:\s*$/m.test(ciWorkflow))
  failures.push(
    'CI treats linux/arm64 as an invalid build-action input instead of a platform value'
  );
const macosPackageScript = await readFile(resolve(root, 'deploy/macos/package.sh'), 'utf8');
if (!macosPackageScript.includes('script/verify-macos-dmg.sh'))
  failures.push('macOS packaging does not verify the completed disk image payload');
for (const required of [
  'workflow_dispatch:',
  "default: '100'",
  'queue: max',
  'script/publish-rolling-release.mjs identity',
  'build-args: VRRELAY_VERSION=',
  'push-by-digest=true',
  'docker buildx imagetools create',
  'Verify anonymous OCI access for a public repository',
  'docker logout ghcr.io',
  'docker buildx imagetools inspect',
  'io.vrrelay.build.id=${{ needs.gate.outputs.build_id }}',
  'provenance: true',
  'VRRELAY_FFMPEG_SOURCE_BUNDLE_URL',
  'FFmpeg-BtbN-source.tar.xz',
  'script/windows-source-bundle.mjs --verify',
  "pattern: 'vrrelay-*'",
  'merge-multiple: true',
  'actions/attest@',
  'script/publish-rolling-release.mjs prepare',
  'script/publish-rolling-release.mjs publish',
  'node script/pin-release-chart.mjs',
  'needs: [gate, oci]',
  'docs/releasing.md',
  'VRRELAY_BUILD_ID',
  'VRRELAY_BUILD_RUN_ATTEMPT: ${{ needs.gate.outputs.run_attempt }}'
]) {
  if (!releaseWorkflow.includes(required))
    failures.push(`release workflow does not enforce release metadata ${required}`);
}
const kubernetesValues = await readFile(resolve(root, 'deploy/kubernetes/values.yaml'), 'utf8');
if (
  !kubernetesValues.includes(
    "image: { repository: ghcr.io/tdeverx/vrrelay, tag: 'latest', digest: ''"
  )
)
  failures.push('source Helm chart must default to the rolling OCI tag that is actually published');
if (
  releaseWorkflow.indexOf('script/publish-rolling-release.mjs publish') >
  releaseWorkflow.indexOf('docker buildx imagetools create')
)
  failures.push('release workflow advances OCI latest before publishing the complete release');
if (/^\s+tags:/m.test(releaseWorkflow))
  failures.push('release workflow must not retain staging or per-build OCI tags');
for (const forbidden of [
  "tags: ['v*']",
  'softprops/action-gh-release@',
  'actions/attest-build-provenance@',
  'overwrite_files'
]) {
  if (releaseWorkflow.includes(forbidden))
    failures.push(
      `release workflow retains forbidden per-build or overwriting behavior ${forbidden}`
    );
}
const rollingReleasePublisher = await readFile(
  resolve(root, 'script/publish-rolling-release.mjs'),
  'utf8'
);
if (
  rollingReleasePublisher.indexOf('await client.updateTag(context.sha)') >
  rollingReleasePublisher.indexOf('await client.updateRelease(')
)
  failures.push('rolling release publisher must move latest before refreshing the release body');
for (const required of [
  "rollingReleaseTag = 'latest'",
  'rollingReleaseAssetLimit = 900',
  'Refusing to overwrite historical release asset',
  'The first rolling release deliverable must be product build 100',
  'assets.push(await describeFile(directory, manifestName))',
  'draft: true',
  'force: true',
  'immutable',
  'digest'
]) {
  if (!rollingReleasePublisher.includes(required))
    failures.push(`rolling release publisher is missing append-only guardrail ${required}`);
}
for (const required of [
  "asset.state === 'starter'",
  "asset.state === undefined || asset.state === 'uploaded'",
  'client.deleteIncompleteAsset(asset.id)',
  "positiveInteger(assetId, 'GitHub release asset id')"
]) {
  if (!rollingReleasePublisher.includes(required))
    failures.push(`rolling release publisher is missing incomplete-upload guardrail ${required}`);
}
if (
  rollingReleasePublisher.includes("method: 'DELETE'") &&
  !rollingReleasePublisher.includes('deleteIncompleteAsset(assetId)')
)
  failures.push('rolling release publisher contains an unscoped destructive request');

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
if (!/tag:\s*['"]latest['"]/.test(helmValues))
  failures.push('Helm image tag must default to the published rolling tag');
for (const template of helmTemplates) {
  if (!template.includes('default "latest" .Values.image.tag'))
    failures.push('Helm workload does not fall back to the published rolling tag');
}

const versionedSources = await Promise.all(
  [
    'apps/relay/src/server.ts',
    'apps/web/src/lib/new-ui/components/AdminShell.svelte',
    'apps/web/src/routes/dashboard/settings/profiles/+page.svelte'
  ].map((path) => readFile(resolve(root, path), 'utf8'))
);
for (const source of versionedSources) {
  if (source.includes("'0.1.0'") || source.includes('v0.1.0'))
    failures.push('runtime or dashboard contains a hard-coded application version');
}
for (const path of [
  'packages/adapters/src/ffmpeg-transcoder.ts',
  'packages/adapters/src/jellyfin-provider.ts',
  'packages/adapters/src/ffmpeg-live-normalizer.ts',
  'packages/adapters/src/supervised-child-process.ts',
  'packages/application/src/vod-producer-coordinator.ts',
  'packages/application/src/profile-service.ts',
  'packages/application/src/session-service.ts',
  'packages/application/src/live-service.ts',
  'packages/application/src/session-cache.ts',
  'packages/application/src/session-jobs.ts',
  'packages/application/src/vod-source-pacing.ts'
]) {
  const source = await readFile(resolve(root, path), 'utf8');
  for (const forbidden of [
    /\bprocess\.platform\b/,
    /from ['"]node:os['"]/,
    /\bDeno\.build\.os\b/,
    /['"](?:darwin|win32|linux)['"]/
  ]) {
    if (forbidden.test(source))
      failures.push(
        `${path} contains OS-specific streaming behavior; core media fixes must be global`
      );
  }
}
for (const retiredPath of [
  'apps/web/src/hooks.ts',
  'apps/web/src/lib/components/AppShell.svelte',
  'apps/web/src/routes/new/+page.svelte',
  'apps/web/src/routes/settings/+page.svelte'
]) {
  if (repositoryRelativeFiles.has(retiredPath))
    failures.push(`retired dashboard compatibility path was restored: ${retiredPath}`);
}

const runtimeManifest = JSON.parse(
  await readFile(resolve(root, 'deploy/runtime-manifest.json'), 'utf8')
);
const runtimeComponents = new Map(
  runtimeManifest.components.map((component) => [component.name, component])
);
if (!dockerfile.includes(`node:${runtimeComponents.get('node')?.version}-trixie-slim`))
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
const ffmpegComponent = runtimeComponents.get('ffmpeg');
const sharedFfmpegRevision = ffmpegComponent?.artifacts?.source?.ffmpegCommit;
const expectedFfmpegRuntimeVersion = `${ffmpegComponent?.version}-22-g${sharedFfmpegRevision?.slice(0, 10)}`;
const macFfmpegRecipe = ffmpegComponent?.sourceBuilds?.['darwin-arm64'];
const macFfmpegInput = macFfmpegRecipe?.inputs?.find((input) => input.name === 'ffmpeg');
for (const [platform, revision] of [
  ['shared source', sharedFfmpegRevision],
  ['macOS recipe', macFfmpegRecipe?.ffmpegCommit],
  ['macOS source input', macFfmpegInput?.revision],
  ['Linux x64', ffmpegLinux[0]?.buildRecipe?.ffmpegCommit],
  ['Linux arm64', ffmpegLinux[1]?.buildRecipe?.ffmpegCommit],
  ['Windows x64', ffmpegWindows?.buildRecipe?.ffmpegCommit]
]) {
  if (!/^[0-9a-f]{40}$/.test(revision ?? '') || revision !== sharedFfmpegRevision)
    failures.push(`${platform} FFmpeg source revision differs from the shared production revision`);
}
if (ffmpegComponent?.runtimeVersion !== expectedFfmpegRuntimeVersion)
  failures.push('FFmpeg exact runtime version does not derive from its shared source revision');
if (
  macFfmpegInput?.version !== ffmpegComponent?.version ||
  macFfmpegInput?.file !== ffmpegComponent?.artifacts?.source?.file ||
  macFfmpegInput?.url !== ffmpegComponent?.artifacts?.source?.url ||
  ffmpegComponent?.artifacts?.source?.url !== ffmpegComponent?.source ||
  macFfmpegInput?.sha256 !== ffmpegComponent?.artifacts?.source?.sha256
)
  failures.push('FFmpeg platform recipe does not consume the shared versioned source artifact');
if (!dockerfile.includes(`ffmpeg version n${expectedFfmpegRuntimeVersion}`))
  failures.push('OCI packaging does not verify the exact shared FFmpeg runtime revision');
const profileService = await readFile(
  resolve(root, 'packages/application/src/profile-service.ts'),
  'utf8'
);
if (
  !profileService.includes("encoder: 'libx264'") ||
  !profileService.includes("hardwareMode: 'software'")
)
  failures.push('built-in media profiles must use the same software encoder on every platform');
const linuxFfmpegInstaller = await readFile(
  resolve(root, 'script/install-pinned-ffmpeg-linux.sh'),
  'utf8'
);
const windowsFfmpegInstaller = await readFile(
  resolve(root, 'script/install-pinned-ffmpeg-windows.ps1'),
  'utf8'
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
for (const required of [
  ffmpegWindows?.file,
  ffmpegWindows?.buildRecipe?.releaseTag,
  'script\\verify-runtime.mjs'
]) {
  if (required && !windowsFfmpegInstaller.includes(required))
    failures.push(`Windows FFmpeg installer does not consume pinned runtime ${required}`);
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
  for (const required of [artifact?.file, artifact?.buildRecipe?.releaseTag]) {
    if (required && !linuxFfmpegInstaller.includes(required))
      failures.push(`Linux FFmpeg installer does not consume pinned runtime ${required}`);
  }
  for (const value of Object.values(artifact?.buildRecipe ?? {}).flat()) {
    if (typeof value === 'string' && !sourceBuilder.includes(value))
      failures.push(`FFmpeg source builder does not cover Linux recipe value ${value}`);
  }
}
const windowsPackager = await readFile(resolve(root, 'deploy/windows/package.ps1'), 'utf8');
for (const required of [
  runtimeComponents.get('ffmpeg')?.artifacts?.['windows-x64']?.file,
  '$ExpectedFfmpegRuntimeVersion',
  'runtime-provenance.mjs',
  'build-tray.ps1',
  'VRRelayTray.exe'
]) {
  if (required && !windowsPackager.includes(required))
    failures.push(`Windows packager does not consume pinned runtime ${required}`);
}
const runtimeProvenance = await readFile(resolve(root, 'script/runtime-provenance.mjs'), 'utf8');
if (!runtimeProvenance.includes('component.runtimeVersion ?? component.version'))
  failures.push('runtime provenance does not verify exact component runtime revisions');
if (runtimeComponents.has('electron') || /electron/i.test(windowsPackager))
  failures.push('Windows packaging must not retain the removed Electron runtime');
for (const required of ['release-version.mjs', 'VRRELAY_VERSION', '__VRRELAY_VERSION__']) {
  if (!windowsPackager.includes(required))
    failures.push(`Windows packager does not propagate release version through ${required}`);
}
const macPackager = await readFile(resolve(root, 'deploy/macos/package.sh'), 'utf8');
for (const required of ['release-version.mjs', 'CFBundleShortVersionString', 'VRRELAY_VERSION']) {
  if (!macPackager.includes(required))
    failures.push(`macOS packager does not propagate release version through ${required}`);
}
if (releaseWorkflow.includes('brew install ffmpeg@7'))
  failures.push('release workflow installs the macOS FFmpeg runtime from Homebrew');
if (!macPackager.includes('deploy/macos/build-ffmpeg.sh'))
  failures.push('macOS packager does not consume the pinned FFmpeg source builder');
if (/choco install ffmpeg/.test(releaseWorkflow))
  failures.push('release workflow installs an unpinned Chocolatey FFmpeg package');

const macService = await readFile(
  resolve(root, 'apps/macos/Sources/VRRelayMac/RelayService.swift'),
  'utf8'
);
const macViews = await readFile(resolve(root, 'apps/macos/Sources/VRRelayMac/Views.swift'), 'utf8');
const macInstaller = await readFile(resolve(root, 'deploy/macos/install-service.sh'), 'utf8');
if (!macService.includes('install-service') || !macInstaller.includes('gui/$USER_ID'))
  failures.push('macOS host does not install and control the packaged per-user LaunchAgent');
for (const forbidden of [
  '/Library/LaunchDaemons',
  'system/org.vrrelay.service',
  'administrator privileges',
  '/usr/bin/osascript',
  '/Users/admin/Documents/VRR'
]) {
  if (`${macService}\n${macViews}\n${macInstaller}`.includes(forbidden))
    failures.push(
      `macOS host contains a forbidden service path or elevation mechanism: ${forbidden}`
    );
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
