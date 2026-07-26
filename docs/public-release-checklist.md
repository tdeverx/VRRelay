# Public release checklist

This checklist defines the difference between a buildable repository, a release candidate, and a supported VRRelay release. A maintainer must attach or link the evidence for every release-blocking item before merging the commit that GitHub Actions will publish.

## Repository publication

- Create the initial signed commit without local `.env`, `.data`, generated certificates, provider credentials, media, logs, or build output.
- Enable GitHub secret scanning, push protection, Dependabot alerts, private vulnerability reporting, and code scanning.
- Protect `main`: block direct pushes, require merge queue, one approving review, resolved conversations, linear history, signed commits where practical, and the CI, distributed acceptance, and security checks. Require the same checks for merge-queue commits so the published SHA is the tested SHA.
- Restrict tag creation and GitHub release publication to maintainers. Permit the Actions identity to force-update only the rolling lightweight `latest` tag, and do not create per-build release tags. Use an environment approval rule for production release jobs if the repository has multiple maintainers.
- Set the project description, GPL-3.0-or-later license metadata, topics, support URL, security policy, and default issue templates.

## Release-blocking engineering evidence

- `npm run ci` passes from a clean checkout on Linux, macOS, and Windows.
- The Linux distributed-acceptance workflow passes both the real-process smoke test and the two-worker/two-edge container harness.
- The filesystem/container security scan has no unresolved high or critical finding, and the generated SBOM is retained.
- The Helm chart lints, renders, rejects shared-identity replica counts, and exposes controller mTLS, edge HTTPS, and authenticated ingest through distinct services; standalone and every multi-host Compose role resolve with production-style environment values.
- The macOS DMG supports drag-to-Applications installation, first-start service installation, in-app runtime upgrades, menu-app exit/logout/reboot, successful streaming, Gatekeeper assessment, and retained-data uninstall.
- The Windows installer passes install, service recovery, repair, upgrade, reboot, DPAPI storage, tray exit, and retained-data uninstall tests on Windows x64.
- Backup, restore, upgrade, rollback, certificate rotation, node drain, and node revocation have retained logs from the release candidate.
- Every downloaded archive passes the runtime-manifest checksum, every executable reports the declared exact runtime revision (including the shared FFmpeg commit), and each native artifact contains a post-signing `runtime-provenance.json` whose hashes match the binaries actually installed.
- The FFmpeg complete corresponding-source archive is generated for the exact pinned Windows, Linux x64, and Linux arm64 BtbN builds; its immutable URL and SHA-256 are configured as repository variables, and the release workflow successfully attaches and checksums it.
- The source archive's embedded recipe and per-file manifest pass `node script/windows-source-bundle.mjs --verify`, all production platforms resolve to the same FFmpeg source revision, and a maintainer has audited the collected linked-library sources against the binary configuration before dispatch.

## Product evidence

- A fresh administrator can complete standalone setup, connect Jellyfin, browse media, create a finite VOD URL, seek, stop, restart, and delete the session using only the documented workflow.
- A fresh administrator can create a live channel, publish from OBS, obtain the clean relay URL, reconnect the publisher, and stop the channel.
- A multi-host operator can enroll each role, bind Jellyfin only to selected source workers, preview placement, observe one coalesced encode, drain an edge, and recover after controller restart.
- The dashboard completes keyboard, mobile, screen-reader-name, focus, empty-state, error-state, and browser-console QA.
- Default H.264/AAC VOD and live URLs pass the checked-in VRChat PC matrix over trusted HTTPS. Quest evidence is recorded separately and support is claimed only after a real Quest passes.

## Release mechanics

- Update `CHANGELOG.md`, compatibility evidence, implementation status, runtime manifest, and upgrade notes.
- Merge only after the candidate has passed every required PR and merge-queue gate. The protected `main` push automatically builds and publishes the release; it derives build `100` for the first completed deliverable, reuses a number for a retry of the same SHA, and otherwise assigns the next completed build number. The release workflow retains artifact/security validation without rerunning functional acceptance suites.
- Verify the build-numbered artifact checksums, manifests, SBOM/provenance, install each final artifact, and perform one post-package VRChat smoke test. Confirm the publisher appended the assets without deleting or replacing any historical filename, then advanced only the GitHub and OCI `latest` tags.
- Verify `/api/v1/health`, the dashboard, and Helm app metadata report the semantic package version. Verify OCI labels, macOS DMG/app metadata, Windows installer metadata, and the build manifest carry the explicit product build identity where those formats support it. Verify the manifest records the full source commit and immutable OCI digest, and the packaged Helm chart renders that same relay digest.
- Confirm the rolling release remains below the publisher's 900-asset safety threshold and that GHCR cleanup retains every digest referenced by a historical manifest.
- For a public repository, deliberately set the linked `ghcr.io/<owner>/<repository>` package to public and verify an anonymous digest pull before announcing the first build. New GHCR packages start private, and changing package visibility to public is an explicit, effectively irreversible administrator decision; the release workflow fails closed until anonymous inspection succeeds. Keep private-repository packages private and configure authenticated pull secrets instead.
- Publish known limitations prominently. Experimental codecs and delivery methods remain labelled experimental until recorded VRChat evidence promotes them.

The public repository may be opened after the feature-complete release-candidate gate passes, before the supported-v1 target-environment gates are complete, provided the README and implementation status make that distinction explicit. A private development remote may exist earlier. “Feature complete” means the documented v1 scope is implemented; “released” additionally requires every target-environment and real-client gate above.
