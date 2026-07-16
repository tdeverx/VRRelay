# Releasing VRRelay

VRRelay releases are created from signed semantic-version tags such as `v1.0.0`. The release workflow validates the tag once and passes the normalized version to the service, dashboard, OCI image, Helm chart, macOS DMG, and Windows installer. Do not build public artifacts by editing version strings manually.

## Before tagging

1. Run `npm ci` and `npm run ci` on a clean checkout.
2. Complete the standalone and distributed acceptance tests documented in [testing.md](testing.md).
3. Record the required real VRChat PC evidence. Quest claims require separate trusted-HTTPS device evidence.
4. Review dependency and container scans, update `deploy/runtime-manifest.json`, and confirm every runtime checksum from its authoritative upstream release.
5. Confirm the Apple and Windows signing secrets are present when publishing signed native artifacts.

The macOS release job expects these repository secrets:

- `APPLE_DEVELOPER_ID`: the Developer ID Application identity name.
- `APPLE_SIGNING_CERTIFICATE`: the base64-encoded PKCS#12 certificate and
  private-key bundle.
- `APPLE_SIGNING_CERTIFICATE_PASSWORD` and `APPLE_KEYCHAIN_PASSWORD`: the
  PKCS#12 and temporary-Keychain passwords.
- `APPLE_NOTARY_PROFILE`: the temporary `notarytool` profile name.
- `APPLE_NOTARY_KEY`: the base64-encoded App Store Connect API `.p8` key,
  together with `APPLE_NOTARY_KEY_ID` and `APPLE_NOTARY_ISSUER_ID`.

On a fresh runner the workflow writes the certificate and notary key with
private permissions, creates and unlocks a temporary Keychain, imports the
certificate, provisions the `notarytool` profile, and then runs release-mode
packaging. Nested runtime executables are hardened-runtime signed and
timestamped before the app is signed; the resulting DMG is submitted,
stapled, and validated by the packager. An `always()` cleanup step deletes the
temporary Keychain, certificate, and notary-key files. The workflow wiring is a
guardrail, not evidence that a signed/notarized release has run successfully;
retain the release-job, notarization, stapling, and Gatekeeper results for the
candidate tag.

## Corresponding source

The macOS DMG builds FFmpeg 8.1.2 from the checksum-pinned arm64 recipe in
the runtime manifest. That builder collects every FFmpeg, x264, subtitle, font,
text-shaping, line-breaking, and zimg source input; the exact recipe; build
metadata; configuration; licenses; rebuild instructions; and a per-file
`SHA256SUMS` into
`VRRelay-<version>-macOS-FFmpeg-source.tar.xz`. The release workflow publishes
that archive beside the macOS DMG. Preserve its FriBidi source, license,
and relinking obligations.

Windows and both OCI architectures use the checksum-pinned BtbN GPL builds
recorded in the runtime manifest. Before a tag can publish, maintainers must
generate and host one complete corresponding-source archive covering those
three exact binaries, including FFmpeg commit
`94138f6973dd1ac6208ace92148ac0d172455d65`, the matching BtbN build scripts,
patches, configuration, and every covered linked-library source needed to
rebuild them.

Generate the archive on a machine with Docker, Git, Node, `tar`, `xz`, and ample temporary disk space:

```sh
deploy/windows/build-corresponding-source.sh /absolute/output/ffmpeg-btbn-corresponding-source.tar.xz
```

The builder checks out the exact BtbN release commit recorded in the runtime manifest, runs its source downloader, adds the exact FFmpeg commit used by the binary, removes repository metadata, creates a per-file SHA-256 manifest, and produces a normalized archive. Audit the archive before hosting it; source collection is intentionally not run inside every release because it is large and network-intensive.

Set the repository variables `VRRELAY_FFMPEG_SOURCE_BUNDLE_URL` and `VRRELAY_FFMPEG_SOURCE_BUNDLE_SHA256` to that immutable archive. The release job downloads it, verifies both the outer checksum and embedded recipe manifest, and attaches it alongside the binaries. Missing variables, a failed download, a recipe mismatch, or a checksum mismatch blocks publication. A source URL, build script, or written note without the complete source archive is not accepted by the workflow as a substitute.

The generated release also contains the project license, third-party notices, runtime manifest, checksums, repository SBOM, and versioned Helm chart. GitHub supplies the tagged VRRelay source archives for the project itself.

## Rehearsal and rollback

Run the workflow first from a release-candidate tag. Install the native artifacts on clean machines, deploy the produced OCI image and Helm chart, verify `/api/v1/health` reports the tag version, and exercise one VOD and one live session. Follow [operations.md](operations.md) for backup and rollback. Never overwrite a published tag or artifact; correct it with a new version.
