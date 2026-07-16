# Phase 11 implementation checkpoint — native release guardrails

Date: 2026-07-15

This is a build-first packaging checkpoint. It is not final macOS or Windows
installation evidence, signing evidence, notarization evidence, clean-machine
upgrade/repair/uninstall evidence, or artifact vulnerability-scan evidence.

## Scope completed

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
- `script/check-native-packaging.mjs` validates the runtime manifest and static
  packaging contracts in CI:
  - every bundled runtime component declares version, license, source, and
    SHA-256-pinned artifacts;
  - FFmpeg release binaries keep corresponding-source build recipes;
  - macOS packaging includes notices, FFmpeg license material, runtime
    provenance, package verification, and release signing/notarization gates;
  - Windows packaging includes notices, FFmpeg license material, runtime
    provenance, executable/installer signing, and source-bundle verification.
- `npm run check` now includes `npm run check:native-packaging`.

## Lean guardrails run

Commands:

```text
npm run check:native-packaging
```

Result: the native packaging guard confirmed the release-mode checks, runtime
manifest pins, FFmpeg corresponding-source recipe metadata, notices/license
inclusion, and provenance checks are wired into the packaging scripts.

## Deferred to final high-pass verification

- A pinned minimal headless Apple Silicon FFmpeg build that replaces the current
  Homebrew-binary input path.
- Actual signed/notarized macOS package creation, stapling, and Gatekeeper
  assessment with release credentials.
- Actual signed Windows installer creation with release credentials.
- Clean macOS and Windows install, tray/menu exit, logout, reboot, repair,
  upgrade, rollback, service-failure, retained-data uninstall, and purge-data
  uninstall evidence.
- Final artifact SBOMs, vulnerability scans, checksums, provenance,
  attestations, and corresponding-source archive attachment evidence.
