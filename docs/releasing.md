# Releasing VRRelay

VRRelay releases are created from signed semantic-version tags such as `v1.0.0`. The release workflow validates the tag once and passes the normalized version to the service, dashboard, OCI image, Helm chart, macOS package, and Windows installer. Do not build public artifacts by editing version strings manually.

## Before tagging

1. Run `npm ci` and `npm run ci` on a clean checkout.
2. Complete the standalone and distributed acceptance tests documented in [testing.md](testing.md).
3. Record the required real VRChat PC evidence. Quest claims require separate trusted-HTTPS device evidence.
4. Review dependency and container scans, update `deploy/runtime-manifest.json`, and confirm every runtime checksum from its authoritative upstream release.
5. Confirm the Apple and Windows signing secrets are present when publishing signed native artifacts.

## Corresponding source

The macOS package uses FFmpeg 7.1.5 and the workflow attaches that release source. Windows and both OCI architectures use the checksum-pinned BtbN GPL builds recorded in the runtime manifest. Before a tag can publish, maintainers must generate and host one complete corresponding-source archive covering all three exact binaries, including FFmpeg commit `7d0e8420048cffd0ca3883b877ead2390496d0b2`, the matching BtbN build scripts, patches, configuration, and every covered linked-library source needed to rebuild them.

Generate the archive on a machine with Docker, Git, Node, `tar`, `xz`, and ample temporary disk space:

```sh
deploy/windows/build-corresponding-source.sh /absolute/output/ffmpeg-btbn-corresponding-source.tar.xz
```

The builder checks out the exact BtbN release commit recorded in the runtime manifest, runs its source downloader, adds the exact FFmpeg commit used by the binary, removes repository metadata, creates a per-file SHA-256 manifest, and produces a normalized archive. Audit the archive before hosting it; source collection is intentionally not run inside every release because it is large and network-intensive.

Set the repository variables `VRRELAY_FFMPEG_SOURCE_BUNDLE_URL` and `VRRELAY_FFMPEG_SOURCE_BUNDLE_SHA256` to that immutable archive. The release job downloads it, verifies both the outer checksum and embedded recipe manifest, and attaches it alongside the binaries. Missing variables, a failed download, a recipe mismatch, or a checksum mismatch blocks publication. A source URL, build script, or written note without the complete source archive is not accepted by the workflow as a substitute.

The generated release also contains the project license, third-party notices, runtime manifest, checksums, repository SBOM, and versioned Helm chart. GitHub supplies the tagged VRRelay source archives for the project itself.

## Rehearsal and rollback

Run the workflow first from a release-candidate tag. Install native packages on clean machines, deploy the produced OCI image and Helm chart, verify `/api/v1/health` reports the tag version, and exercise one VOD and one live session. Follow [operations.md](operations.md) for backup and rollback. Never overwrite a published tag or artifact; correct it with a new version.
