# Phase 11 implementation checkpoint — pinned macOS runtime and release guardrails

Date: 2026-07-16

This is a build-first packaging checkpoint. It is not final macOS or Windows
installation evidence, signing evidence, notarization evidence, clean-machine
upgrade/repair/uninstall evidence, or artifact vulnerability-scan evidence.

## Scope completed

- `deploy/macos/build-ffmpeg.sh` builds a minimal headless FFmpeg 7.1.5 binary
  for arm64/macOS 15 from the structured source recipe in
  `deploy/runtime-manifest.json`. The eight exact FFmpeg, x264, libass,
  FreeType, FriBidi, HarfBuzz, libunibreak, and zimg source inputs are HTTPS-only
  and SHA-256 pinned with versions and licenses.
- The builder disables ambient dependency autodetection, FFplay, FFprobe,
  documentation, debug output, unnecessary device inputs, and shared
  third-party libraries. It requires the recorded encoders, filters, muxers,
  and protocols, rejects non-system dynamic dependencies, and performs a real
  generated H.264/yuv420p/AAC MPEG-TS encode/decode smoke check.
- Each build emits the arm64 executable, structured build/configuration/toolchain
  metadata, dependency license files, and a complete corresponding-source
  archive with the exact inputs, recipe, configuration, rebuild instructions,
  and per-file `SHA256SUMS`. The archive supports an offline source rebuild
  through `VRRELAY_FFMPEG_SOURCE_DIR`.
- macOS packaging uses that builder by default. Release mode rejects an
  arbitrary `VRRELAY_FFMPEG_BINARY`; the variable remains available only for
  local development packaging. The generated build metadata is included in the
  runtime and the complete source archive is emitted beside the installer.
- macOS packaging now has an explicit release mode through
  `VRRELAY_RELEASE_PACKAGING=1`. Release mode fails before staging if the
  Developer ID application identity, Developer ID installer identity, or
  notary profile is missing.
- macOS release verification sets `VRRELAY_REQUIRE_PACKAGE_SIGNATURE=1` before
  running `script/verify-macos-package.sh`, so a release package cannot pass the
  local verifier as an unsigned installer.
- Windows packaging now has the same `VRRELAY_RELEASE_PACKAGING=1` switch.
  Release mode fails before staging if the Windows signing certificate,
  certificate password, or FFmpeg corresponding-source bundle path is missing.
- Windows release packaging verifies the supplied FFmpeg corresponding-source
  bundle with `script/windows-source-bundle.mjs --verify` before downloading or
  staging runtime binaries.
- Nested macOS runtime executables and bundled dynamic libraries are signed with
  the hardened runtime and a trusted timestamp when a Developer ID identity is
  present; development packaging keeps ad-hoc signing.
- The release workflow now sets `VRRELAY_RELEASE_PACKAGING=1` for both native
  jobs. On a fresh macOS runner it imports a base64 PKCS#12 certificate into a
  temporary Keychain, provisions a `notarytool` profile from a temporary
  App Store Connect API key, then deletes the Keychain and credential files in
  an `always()` cleanup step. Its Windows job downloads the hosted FFmpeg
  corresponding-source bundle, verifies the configured SHA-256, and passes the
  verified local archive to the Windows packager.
- `script/check-native-packaging.mjs` validates the runtime manifest and static
  packaging contracts in CI:
  - every bundled runtime component declares version, license, source, and
    SHA-256-pinned artifacts;
  - FFmpeg release binaries keep corresponding-source build recipes;
  - macOS packaging includes notices, all source-input license material,
    source-build metadata, runtime provenance, package verification, and release
    signing/notarization gates;
  - Windows packaging includes notices, FFmpeg license material, runtime
    provenance, executable/installer signing, and source-bundle verification.
  - The release workflow invokes native packaging in release mode and hands the
    verified FFmpeg source bundle to the Windows packager.
- `npm run check` now includes `npm run check:native-packaging`.

## Local build and lean guardrails

Commands:

```text
npm run check:native-packaging
deploy/macos/build-ffmpeg.sh "$PWD/tmp/macos-ffmpeg-test"
file tmp/macos-ffmpeg-test/ffmpeg
otool -L tmp/macos-ffmpeg-test/ffmpeg
```

Results:

- The native packaging guard passed.
- The source build completed locally on Apple Silicon with Xcode 26.6 and Apple
  clang 21. The output was a thin arm64 Mach-O FFmpeg 7.1.5 executable targeting
  macOS 15; its dynamic load graph contained only Apple system frameworks and
  `/usr/lib` libraries.
- The builder's capability checks and generated MPEG-TS encode/decode smoke test
  passed. It emitted build metadata, all eight license files, and the complete
  source archive.
- The observed binary SHA-256 was
  `8fcb5328a573c1a319b0b0301c9ca90dbe8a4d5844f032d746e44fa09f853999`; the
  observed source-archive SHA-256 was
  `70e9993b7e194501edda62a5567ecc88c384860fe144b76223390e849a9c144f`.
  These identify this local build only; bit-for-bit reproducibility is not yet
  claimed because the build-tool binaries themselves are not checksum-pinned.
- The development package pipeline staged that source-built runtime and passed
  `script/verify-macos-package.sh`. It emitted the expected unsigned local
  `VRRelay-0.1.0-macOS-arm64.pkg`; signed/notarized release output remains gated
  on external Apple credentials.

## Deferred to final high-pass verification

- Actual signed/notarized macOS package creation, stapling, and Gatekeeper
  assessment with release credentials. The fresh-runner workflow is statically
  guarded but has not been executed in a release job from this checkout.
- Actual signed Windows installer creation with release credentials.
- Clean macOS and Windows install, tray/menu exit, logout, reboot, repair,
  upgrade, rollback, service-failure, retained-data uninstall, and purge-data
  uninstall evidence.
- Final artifact SBOMs, vulnerability scans, checksums, provenance,
  attestations, and corresponding-source archive attachment evidence.
- A release/legal review of the statically linked FriBidi
  LGPL-2.1-or-later source, license, and relinking obligations.
