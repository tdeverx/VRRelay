# Releasing VRRelay

GitHub Actions is the authoritative VRRelay builder. Maintainers dispatch the
`Release` workflow from `main` with an explicit positive product build number.
The first rolling deliverable is build `100`; increment that input for each new
deliverable. The semantic application version still comes from `package.json`
and must not be changed only to distinguish rebuilds.

One lightweight Git tag and one GitHub release are managed by the workflow:
`latest`. There are no per-build release tags. The `latest` ref and release
summary advance only after a complete build has been attached and verified.

## Build identity and history

Every full workflow attempt receives a collision-safe identity containing the
semantic version, product build number, GitHub run ID, gate run attempt, and
source commit. Build 100 could therefore produce an identity such as:

```text
0.1.0-b000100-r987654321-a1-g0123456789ab
```

Native installers, corresponding-source archives, release metadata, checksums,
and the build manifest include that identity in their filenames. Re-running
only failed jobs preserves the successful gate's authoritative attempt so old
and rebuilt jobs cannot produce mixed filenames. The workflow replaces only
its transient same-run handoff artifacts during such a retry; published release
assets remain append-only. Re-running every job also re-runs the gate and
receives a new attempt-specific filename, because timestamped signatures may
produce different bytes.

`script/publish-rolling-release.mjs` appends these files to the `latest`
release. It lists existing assets before upload and never calls a release-asset
or tag deletion API for an uploaded asset. GitHub can leave a zero-byte
`starter` asset after an interrupted upload; a retry may delete only that
same-name incomplete placeholder before relisting and uploading it again. An
uploaded filename is reused only when GitHub's server-side SHA-256 digest and
byte size exactly match; any mismatch fails the release rather than
overwriting history. Incomplete manifest placeholders never count toward the
completed build-number sequence. The checksum file is generated from the
completed artifacts and the manifest is uploaded last, so an uploaded manifest
marks one complete build.

After every asset, including the manifest, is present, the publisher first
moves the lightweight `latest` ref to the candidate commit and then refreshes
the release body. This ordering lets the scoped Actions token update a release
whose candidate changed workflow files. If the body update fails, a retry
reuses the verified assets, repeats the idempotent ref move, and repairs the
body before OCI `latest` is promoted.

The mutable release body links the current build. The release asset list and
the immutable per-build manifests are the historical index. There is no
same-name `latest` installer alias, because maintaining one would require
deleting or replacing an asset; use the stable `/releases/tag/latest` page or
query the release API for the current manifest.

GitHub Actions artifacts are only the handoff between build jobs and the
publisher. They expire according to repository retention settings and are not
the historical archive.

## Before dispatching

1. Run `npm ci` and `npm run ci` on a clean checkout.
2. Complete the standalone and distributed acceptance tests documented in
   [testing.md](testing.md).
3. Record the required real VRChat PC evidence. Quest claims require separate
   trusted-HTTPS device evidence.
4. Review dependency and container scans, update
   `deploy/runtime-manifest.json`, and confirm every runtime checksum from its
   authoritative upstream source.
5. Confirm the product build input is greater than the last completed
   deliverable. Reusing a number is reserved for a rerun of that deliverable.
6. Confirm the Apple and Windows signing secrets and the FFmpeg
   corresponding-source variables are present.

The macOS release job expects `APPLE_DEVELOPER_ID`,
`APPLE_SIGNING_CERTIFICATE`, `APPLE_SIGNING_CERTIFICATE_PASSWORD`,
`APPLE_KEYCHAIN_PASSWORD`, `APPLE_NOTARY_PROFILE`, `APPLE_NOTARY_KEY`,
`APPLE_NOTARY_KEY_ID`, and `APPLE_NOTARY_ISSUER_ID`. The workflow creates a
temporary Keychain, imports the signing identity, provisions `notarytool`,
signs and timestamps nested executables, signs the app, notarizes and staples
the DMG, validates the final image, and removes the temporary credentials in an
`always()` cleanup step.

The Windows job requires `WINDOWS_CERTIFICATE` and
`WINDOWS_CERTIFICATE_PASSWORD`. It signs the bundled executables and final Inno
Setup installer. Both native packages embed the same semantic version and
explicit product build number.

## Corresponding source

The macOS DMG builds FFmpeg from the checksum-pinned source recipe in the
runtime manifest. Its build emits the exact recipe, metadata, configuration,
licenses, rebuild instructions, source inputs, and per-file `SHA256SUMS` in the
build-numbered macOS FFmpeg source archive.

Windows and both OCI architectures use the checksum-pinned BtbN GPL build
recorded in the runtime manifest. Generate its complete corresponding-source
archive on a machine with Docker, Git, Node, `tar`, `xz`, and sufficient
temporary disk space:

```sh
deploy/windows/build-corresponding-source.sh /absolute/output/ffmpeg-btbn-corresponding-source.tar.xz
```

Audit the archive, then set
`VRRELAY_FFMPEG_SOURCE_BUNDLE_URL` and
`VRRELAY_FFMPEG_SOURCE_BUNDLE_SHA256` to its immutable location and digest.
The workflow downloads it independently in the Windows and metadata jobs,
verifies the outer checksum and embedded recipe, and attaches the exact source
used by that build. Missing source, checksum drift, or recipe drift blocks
publication.

All production platforms must resolve to the same FFmpeg source revision.
Platform-specific compiler flags, hardware integrations, packaging, and
signing remain allowed; the dependency version, source commit, and product
build identity may not drift between macOS, Linux, and Windows.

The release metadata archive also contains the project license, third-party
notices, runtime manifest, repository SBOM, versioned Helm chart, and their
checksums. The packaged release chart pins the relay repository and immutable
OCI digest from the same manifest; the source chart's mutable fallback is
`latest`, never a semantic-version tag that the workflow does not publish. The
moving `latest` tag means GitHub's automatic source ZIP and tarball describe
only the current commit. Historical manifests record the full commit SHA; use
that immutable SHA when retrieving historical VRRelay source.

## Provenance, limits, and rollback

The OCI workflow first pushes the multi-platform image by digest without a
per-build tag. After the native assets, source metadata, attestations, rolling
release, and manifest have all published successfully, the final job advances
only `ghcr.io/<owner>/<repository>:latest` to that digest. A failed promotion is
safe to retry: the completed build remains available by digest and `latest`
never advances to an incomplete build. The manifest records the immutable
digest, and the build emits registry provenance and an SBOM. Historical
containers are selected by
`ghcr.io/<owner>/<repository>@sha256:<digest>`; package cleanup must retain
those untagged digests. Public repositories also receive GitHub build
provenance attestations for the completed native and metadata assets:

```sh
gh attestation verify VRRelay-<build-id>-macOS-arm64.dmg --repo <owner>/<repository>
```

For a public repository, a newly created GHCR package still starts private.
After the first digest push, an administrator must deliberately change the
linked package to public; that visibility decision is not automatically
reversed. The workflow logs out of GHCR and anonymously inspects the exact
digest before allowing public release jobs to continue. A first run may
therefore stop at this gate, after which the administrator can set visibility
and re-run only the failed jobs. Private repositories skip the anonymous gate
and must provide image-pull credentials to their deployments.

The rolling design requires a mutable GitHub release. Repository or
organization release immutability must not be enabled for this release, and
the Actions identity needs a narrowly scoped ruleset exception allowing it to
force-update only `refs/tags/latest`. Ordinary source and release permissions
remain protected.

GitHub permits at most 1,000 assets on one release. The publisher fails closed
at 900 rather than deleting history. Establish immutable external archive
storage and update this policy before reaching that threshold; do not prune old
assets silently.

To roll back, select a completed historical manifest, verify its checksums and
attestation, reinstall its build-numbered native artifact, and deploy the OCI
digest recorded in that same manifest. Do not retag or replace the historical
assets. A corrective build receives a new product build number and is appended
through the same GitHub Actions workflow.
