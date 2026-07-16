// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'deploy/runtime-manifest.json'), 'utf8'));
const macPackage = readFileSync(resolve(root, 'deploy/macos/package.sh'), 'utf8');
const macVerifier = readFileSync(resolve(root, 'script/verify-macos-package.sh'), 'utf8');
const windowsPackage = readFileSync(resolve(root, 'deploy/windows/package.ps1'), 'utf8');
const windowsSource = readFileSync(
  resolve(root, 'deploy/windows/build-corresponding-source.sh'),
  'utf8'
);
const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const failures = [];

function requireText(source, text, message) {
  if (!source.includes(text)) failures.push(message);
}

function requireComponent(name) {
  const component = manifest.components.find((candidate) => candidate.name === name);
  if (!component) failures.push(`runtime manifest is missing ${name}`);
  return component;
}

function requireArtifact(component, platform) {
  const artifact = component?.artifacts?.[platform];
  if (!artifact) {
    failures.push(`${component?.name ?? 'unknown component'} is missing ${platform} artifact`);
    return undefined;
  }
  if (!artifact.file || /\s/.test(artifact.file))
    failures.push(`${component.name} ${platform} artifact must have a stable file name`);
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256 ?? ''))
    failures.push(`${component.name} ${platform} artifact must have a SHA-256 pin`);
  return artifact;
}

if (manifest.schemaVersion !== 1) failures.push('runtime manifest schemaVersion must be 1');

for (const name of ['node', 'ffmpeg', 'mediamtx', 'electron', 'winsw']) {
  const component = requireComponent(name);
  if (!component) continue;
  for (const field of ['version', 'license', 'source']) {
    if (!component[field]) failures.push(`${name} must declare ${field}`);
  }
}

const node = requireComponent('node');
const ffmpeg = requireComponent('ffmpeg');
const mediaMtx = requireComponent('mediamtx');
const electron = requireComponent('electron');
const winsw = requireComponent('winsw');

for (const platform of ['darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64']) {
  requireArtifact(node, platform);
}
for (const platform of ['darwin-arm64', 'windows-x64', 'linux-x64', 'linux-arm64'])
  requireArtifact(mediaMtx, platform);
for (const platform of ['source', 'linux-x64', 'linux-arm64', 'windows-x64']) {
  requireArtifact(ffmpeg, platform);
}
requireArtifact(electron, 'win32-x64');
requireArtifact(winsw, 'win32-x64');

for (const platform of ['linux-x64', 'linux-arm64', 'windows-x64']) {
  const recipe = ffmpeg?.artifacts?.[platform]?.buildRecipe;
  if (
    !recipe?.provider ||
    !recipe?.releaseTag ||
    !recipe?.repositoryCommit ||
    !recipe?.ffmpegCommit
  )
    failures.push(`ffmpeg ${platform} must declare its corresponding-source build recipe`);
}

for (const [source, text, message] of [
  [
    packageJson.scripts.check ?? '',
    'check:native-packaging',
    'npm run check must include native packaging guardrails'
  ],
  [
    packageJson.scripts['check:native-packaging'] ?? '',
    'check-native-packaging.mjs',
    'package.json must expose check:native-packaging'
  ],
  [
    macPackage,
    'VRRELAY_RELEASE_PACKAGING',
    'macOS packaging must distinguish development and release packaging'
  ],
  [
    macPackage,
    'APPLE_DEVELOPER_ID is required for release packaging',
    'macOS release packaging must require a Developer ID application identity'
  ],
  [
    macPackage,
    'APPLE_INSTALLER_ID is required for release packaging',
    'macOS release packaging must require a Developer ID installer identity'
  ],
  [
    macPackage,
    'APPLE_NOTARY_PROFILE is required for release packaging',
    'macOS release packaging must require notarization credentials'
  ],
  [
    macPackage,
    'VRRELAY_REQUIRE_PACKAGE_SIGNATURE=1',
    'macOS release verification must require a signed installer package'
  ],
  [macPackage, 'script/runtime-provenance.mjs', 'macOS packaging must emit runtime provenance'],
  [macPackage, 'THIRD_PARTY_NOTICES.md', 'macOS packaging must include third-party notices'],
  [macPackage, 'FFmpeg-GPLv3.txt', 'macOS packaging must include FFmpeg license material'],
  [
    macVerifier,
    'runtime-provenance.json',
    'macOS package verifier must validate runtime provenance'
  ],
  [
    windowsPackage,
    'VRRELAY_RELEASE_PACKAGING',
    'Windows packaging must distinguish development and release packaging'
  ],
  [
    windowsPackage,
    'WINDOWS_CERTIFICATE is required for release packaging',
    'Windows release packaging must require a signing certificate'
  ],
  [
    windowsPackage,
    'WINDOWS_CERTIFICATE_PASSWORD is required for release packaging',
    'Windows release packaging must require the signing certificate password'
  ],
  [
    windowsPackage,
    'VRRELAY_FFMPEG_SOURCE_BUNDLE is required for release packaging',
    'Windows release packaging must require the FFmpeg corresponding-source bundle'
  ],
  [
    windowsPackage,
    'windows-source-bundle.mjs" --verify',
    'Windows release packaging must verify the FFmpeg corresponding-source bundle'
  ],
  [
    windowsPackage,
    'script\\runtime-provenance.mjs',
    'Windows packaging must emit runtime provenance'
  ],
  [windowsPackage, 'THIRD_PARTY_NOTICES.md', 'Windows packaging must include third-party notices'],
  [windowsPackage, 'FFmpeg-GPLv3.txt', 'Windows packaging must include FFmpeg license material'],
  [windowsPackage, 'signtool sign', 'Windows packaging must sign release binaries and installer'],
  [
    windowsSource,
    'windows-source-bundle.mjs" --verify',
    'Windows corresponding-source build must verify the generated bundle'
  ],
  [
    windowsSource,
    'FFMPEG_COMMIT="7d0e8420048cffd0ca3883b877ead2390496d0b2"',
    'Windows corresponding-source recipe must pin the FFmpeg source commit'
  ],
  [
    releaseWorkflow,
    "VRRELAY_RELEASE_PACKAGING: '1'",
    'release workflow must invoke native packagers in release mode'
  ],
  [
    releaseWorkflow,
    'VRRELAY_FFMPEG_SOURCE_BUNDLE_URL',
    'release workflow must download the hosted FFmpeg corresponding-source bundle'
  ],
  [
    releaseWorkflow,
    'VRRELAY_FFMPEG_SOURCE_BUNDLE_SHA256',
    'release workflow must verify the FFmpeg corresponding-source bundle checksum'
  ],
  [
    releaseWorkflow,
    'VRRELAY_FFMPEG_SOURCE_BUNDLE=$bundle',
    'release workflow must pass the verified FFmpeg source bundle to Windows packaging'
  ]
]) {
  requireText(source, text, message);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('Native packaging checks passed.');
