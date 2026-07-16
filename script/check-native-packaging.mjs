// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'deploy/runtime-manifest.json'), 'utf8'));
const macPackage = readFileSync(resolve(root, 'deploy/macos/package.sh'), 'utf8');
const macFfmpegBuild = readFileSync(resolve(root, 'deploy/macos/build-ffmpeg.sh'), 'utf8');
const macVerifier = readFileSync(resolve(root, 'script/verify-macos-package.sh'), 'utf8');
const windowsPackage = readFileSync(resolve(root, 'deploy/windows/package.ps1'), 'utf8');
const windowsHost = readFileSync(resolve(root, 'apps/windows/src/main.ts'), 'utf8');
const windowsSource = readFileSync(
  resolve(root, 'deploy/windows/build-corresponding-source.sh'),
  'utf8'
);
const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const macApp = readFileSync(
  resolve(root, 'apps/macos/Sources/VRRelayMac/VRRelayMacApp.swift'),
  'utf8'
);
const macViews = readFileSync(resolve(root, 'apps/macos/Sources/VRRelayMac/Views.swift'), 'utf8');
const macInfo = readFileSync(resolve(root, 'deploy/macos/Info.plist'), 'utf8');
const failures = [];

function requireText(source, text, message) {
  if (!source.includes(text)) failures.push(message);
}

function rejectText(source, text, message) {
  if (source.includes(text)) failures.push(message);
}

requireText(macApp, 'MenuBarExtra(', 'macOS controller must remain a menu-bar utility');
rejectText(macApp, 'WindowGroup(', 'macOS controller must not embed an application window');
rejectText(macApp, 'Settings {', 'macOS controller must not embed a settings window');
rejectText(macViews, 'WebKit', 'macOS controller must open the dashboard in the system browser');
requireText(
  macInfo,
  '<key>LSUIElement</key><true/>',
  'macOS menu-bar controller must not show a Dock icon'
);
requireText(
  windowsHost,
  'shell.openExternal(dashboard)',
  'Windows tray controller must open the dashboard in the system browser'
);
rejectText(windowsHost, 'BrowserWindow', 'Windows tray controller must not embed an app window');

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

const macFfmpegRecipe = ffmpeg?.sourceBuilds?.['darwin-arm64'];
if (!macFfmpegRecipe) {
  failures.push('ffmpeg is missing its darwin-arm64 source build recipe');
} else {
  for (const [field, expected] of [
    ['buildScript', 'deploy/macos/build-ffmpeg.sh'],
    ['target', 'arm64-apple-darwin'],
    ['minimumMacOS', '15.0'],
    ['linkage', 'static-third-party']
  ]) {
    if (macFfmpegRecipe[field] !== expected)
      failures.push(`ffmpeg darwin-arm64 ${field} must be ${expected}`);
  }

  const expectedInputs = new Map([
    ['ffmpeg', ['7.1.5', 'GPL-3.0-or-later']],
    ['x264', ['r3222-b35605ace3ddf7c1a5d67a2eb553f034aef41d55', 'GPL-2.0-or-later']],
    ['libass', ['0.17.5', 'ISC']],
    ['freetype', ['2.14.3', 'FTL']],
    ['fribidi', ['1.0.16', 'LGPL-2.1-or-later']],
    ['harfbuzz', ['14.2.1', 'MIT']],
    ['libunibreak', ['7.0', 'Zlib']],
    ['zimg', ['3.0.6', 'WTFPL']]
  ]);
  const inputs = new Map((macFfmpegRecipe.inputs ?? []).map((input) => [input.name, input]));
  if (inputs.size !== expectedInputs.size)
    failures.push('ffmpeg darwin-arm64 source build must contain exactly eight source inputs');
  for (const [name, [version, license]] of expectedInputs) {
    const input = inputs.get(name);
    if (!input) {
      failures.push(`ffmpeg darwin-arm64 source build is missing ${name}`);
      continue;
    }
    if (input.version !== version)
      failures.push(`ffmpeg darwin-arm64 ${name} version must be ${version}`);
    if (input.license !== license)
      failures.push(`ffmpeg darwin-arm64 ${name} license must be ${license}`);
    if (!input.file || /\s/.test(input.file))
      failures.push(`ffmpeg darwin-arm64 ${name} must have a stable source file name`);
    if (!/^https:\/\//.test(input.url ?? ''))
      failures.push(`ffmpeg darwin-arm64 ${name} source URL must use HTTPS`);
    if (!/^[0-9a-f]{64}$/.test(input.sha256 ?? ''))
      failures.push(`ffmpeg darwin-arm64 ${name} must have a SHA-256 pin`);
  }
  const ffmpegSourceInput = inputs.get('ffmpeg');
  const ffmpegSourceArtifact = ffmpeg?.artifacts?.source;
  if (
    ffmpegSourceInput?.file !== ffmpegSourceArtifact?.file ||
    ffmpegSourceInput?.sha256 !== ffmpegSourceArtifact?.sha256
  )
    failures.push('macOS and release-metadata FFmpeg source pins must match');

  for (const [field, required] of [
    ['systemLibraries', ['AudioToolbox', 'CoreText', 'VideoToolbox']],
    ['requiredEncoders', ['aac', 'h264_videotoolbox', 'libx264']],
    ['requiredFilters', ['subtitles', 'tonemap', 'zscale']],
    ['requiredMuxers', ['hls', 'mp4', 'mpegts', 'rtsp']],
    ['requiredProtocols', ['file', 'http', 'pipe', 'rtp', 'tcp', 'udp']]
  ]) {
    const values = new Set(macFfmpegRecipe[field] ?? []);
    for (const value of required) {
      if (!values.has(value)) failures.push(`ffmpeg darwin-arm64 ${field} is missing ${value}`);
    }
  }
}

for (const [source, text, message] of [
  [
    ciWorkflow,
    'macos-host:\n    runs-on: macos-15',
    'macOS host verification must run on the minimum supported macOS 15 runner'
  ],
  [
    releaseWorkflow,
    'include: [{ os: macos-15, artifact: macos }',
    'macOS release packaging must run on the minimum supported macOS 15 runner'
  ],
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
  [
    macPackage,
    'codesign --force --options runtime --timestamp --sign "$APPLE_DEVELOPER_ID" "$binary"',
    'macOS release packaging must hardened-sign and timestamp nested runtime binaries'
  ],
  [
    macPackage,
    'VRRELAY_FFMPEG_BINARY is not accepted for release packaging',
    'macOS release packaging must reject external FFmpeg binaries'
  ],
  [
    macPackage,
    'deploy/macos/build-ffmpeg.sh',
    'macOS packaging must build FFmpeg from the checked-in source recipe'
  ],
  [
    macPackage,
    'ffmpeg-build-metadata.json',
    'macOS packaging must include FFmpeg source-build metadata'
  ],
  [
    macPackage,
    'macOS-FFmpeg-source.tar.xz',
    'macOS packaging must publish the FFmpeg corresponding-source bundle'
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
    macVerifier,
    '*.dylib(N)',
    'macOS package verification must allow an empty library directory for static FFmpeg'
  ],
  [
    macFfmpegBuild,
    "sourceBuilds?.['darwin-arm64']",
    'macOS FFmpeg builder must consume the structured runtime-manifest recipe'
  ],
  [macFfmpegBuild, '--enable-static', 'macOS FFmpeg builder must enable static libraries'],
  [macFfmpegBuild, '--disable-shared', 'macOS FFmpeg builder must disable shared libraries'],
  [
    macFfmpegBuild,
    '--disable-autodetect',
    'macOS FFmpeg builder must reject ambient optional dependencies'
  ],
  [macFfmpegBuild, '--disable-ffplay', 'macOS FFmpeg builder must omit FFplay'],
  [macFfmpegBuild, '--disable-ffprobe', 'macOS FFmpeg builder must omit FFprobe'],
  [
    macFfmpegBuild,
    'Built FFmpeg contains a non-system dynamic dependency',
    'macOS FFmpeg builder must enforce a system-only dynamic dependency graph'
  ],
  [
    macFfmpegBuild,
    'vrrelay-ffmpeg-${SOURCE_VERSION[ffmpeg]}-darwin-arm64-source.tar.xz',
    'macOS FFmpeg builder must emit complete corresponding source'
  ],
  [
    macFfmpegBuild,
    'VRRELAY_FFMPEG_SOURCE_DIR',
    'macOS FFmpeg builder must support rebuilding from the attached source bundle'
  ],
  [
    macFfmpegBuild,
    'FriBidi is a statically linked LGPL component',
    'macOS FFmpeg source bundle must retain the FriBidi static-linking caveat'
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
    'security create-keychain',
    'release workflow must create a temporary Apple signing keychain'
  ],
  [
    releaseWorkflow,
    'security import "$certificate"',
    'release workflow must import the Apple signing certificate on a fresh runner'
  ],
  [
    releaseWorkflow,
    'notarytool store-credentials',
    'release workflow must provision notarization credentials on a fresh runner'
  ],
  [
    releaseWorkflow,
    'security delete-keychain',
    'release workflow must remove the temporary Apple signing keychain'
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

if (releaseWorkflow.includes('brew install ffmpeg@7'))
  failures.push('release workflow must not source the macOS FFmpeg runtime from Homebrew');

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('Native packaging checks passed.');
