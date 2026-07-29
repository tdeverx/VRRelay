# Releasing VRRelay

GitHub Actions is the authoritative VRRelay builder. Every protected merge to
`main` starts the `Release` workflow automatically. The publisher derives the
next positive product build number from completed rolling-release manifests:
the first deliverable is build `100`, retries of the same commit reuse its
number, and the next completed commit receives the next number. The semantic
application version still comes from `package.json` and must not be changed
only to distinguish rebuilds.

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

Native installers, corresponding-source archives, checksums, and the build
manifest include that identity in their filenames. Re-running
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

## Before merging

1. Ensure the required pull-request and merge-queue workflows have passed. They
   run the deterministic repository, browser, container, distributed, platform,
   deployment, and security lanes before a merge is allowed.
2. Record the required real VRChat PC evidence. Quest claims require separate
   trusted-HTTPS device evidence.
3. Review dependency and container scans, update
   `deploy/runtime-manifest.json`, and confirm every runtime checksum from its
   authoritative upstream source.
4. Confirm the Apple and Windows signing secrets are present and audit the
   checked-in FFmpeg corresponding-source recipe.

`workflow_dispatch` remains available only to recover or retry a failed
publication from `main`; it never accepts a manually selected build number.

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
recorded in the runtime manifest. The release workflow generates their complete
corresponding-source archive once from that checked-in recipe, verifies its
embedded manifest, and passes the same workflow artifact to Windows packaging
and publication. This keeps source publication tied to the exact FFmpeg
revision used by every production build and does not require separately
configured repository variables.

To generate and audit the same archive locally, use a machine with Docker, Git,
Node, `tar`, `xz`, and sufficient temporary disk space:

```sh
deploy/windows/build-corresponding-source.sh /absolute/output/ffmpeg-btbn-corresponding-source.tar.xz
```

The workflow verifies the embedded recipe independently in the source and
Windows jobs and attaches the exact source used by that build. Missing source
or recipe drift blocks publication.

All production platforms must resolve to the same FFmpeg source revision.
Platform-specific compiler flags, hardware integrations, packaging, and
signing remain allowed; the dependency version, source commit, and product
build identity may not drift between macOS, Linux, and Windows.

The GitHub release intentionally does not duplicate the repository SBOM,
notices, runtime manifest, or Helm chart in a metadata archive. The checked-in
chart's mutable fallback is `latest`, never a semantic-version tag that the
workflow does not publish, and each completed build manifest records the full
source commit and immutable OCI digest. Use that commit to retrieve historical
project source and render the matching chart. GitHub's automatic source ZIP
and tarball follow the moving `latest` tag and therefore describe only the
current commit.

## Provenance, limits, and rollback

The OCI workflow first pushes the multi-platform image by digest without a
per-build tag. After the native assets, corresponding source, attestations, rolling
release, and manifest have all published successfully, the final job advances
only `ghcr.io/<owner>/<repository>:latest` to that digest. A failed promotion is
safe to retry: the completed build remains available by digest and `latest`
never advances to an incomplete build. The manifest records the immutable
digest, and the build emits registry provenance and an SBOM. Historical
containers are selected by
`ghcr.io/<owner>/<repository>@sha256:<digest>`; package cleanup must retain
those untagged digests. Public repositories also receive GitHub build
provenance attestations for the completed native and corresponding-source assets:

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

Each completed build adds six release assets: two native installers, two
FFmpeg corresponding-source archives, one checksum file, and one manifest.
Linux remains distributed as the multi-platform OCI image rather than a native
desktop installer.

To roll back, select a completed historical manifest, verify its checksums and
attestation, reinstall its build-numbered native artifact, and deploy the OCI
digest recorded in that same manifest. Do not retag or replace the historical
assets. A corrective build receives a new product build number and is appended
through the same GitHub Actions workflow.
