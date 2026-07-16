# Public release checklist

This checklist defines the difference between a buildable repository, a release candidate, and a supported VRRelay release. A maintainer must attach or link the evidence for every release-blocking item before creating a version tag.

## Repository publication

- Create the initial signed commit without local `.env`, `.data`, generated certificates, provider credentials, media, logs, or build output.
- Enable GitHub secret scanning, push protection, Dependabot alerts, private vulnerability reporting, and code scanning.
- Protect `main`: require pull requests, one approving review, resolved conversations, linear history, signed commits where practical, and the CI, distributed acceptance, and security checks.
- Restrict tag creation and GitHub release publication to maintainers. Use an environment approval rule for production release jobs if the repository has multiple maintainers.
- Set the project description, GPL-3.0-or-later license metadata, topics, support URL, security policy, and default issue templates.

## Release-blocking engineering evidence

- `npm run ci` passes from a clean checkout on Linux, macOS, and Windows.
- The Linux distributed-acceptance workflow passes both the real-process smoke test and the two-worker/two-edge container harness.
- The filesystem/container security scan has no unresolved high or critical finding, and the generated SBOM is retained.
- The Helm chart lints, renders, rejects shared-identity replica counts, and exposes controller mTLS, edge HTTPS, and authenticated ingest through distinct services; standalone and every multi-host Compose role resolve with production-style environment values.
- The macOS DMG supports drag-to-Applications installation, first-start service installation, in-app runtime upgrades, menu-app exit/logout/reboot, successful streaming, Gatekeeper assessment, and retained-data uninstall.
- The Windows installer passes install, service recovery, repair, upgrade, reboot, DPAPI storage, tray exit, and retained-data uninstall tests on Windows x64.
- Backup, restore, upgrade, rollback, certificate rotation, node drain, and node revocation have retained logs from the release candidate.
- Every downloaded archive passes the runtime-manifest checksum, every executable reports the declared version, and each native artifact contains a post-signing `runtime-provenance.json` whose hashes match the binaries actually installed.
- The FFmpeg complete corresponding-source archive is generated for the exact pinned Windows, Linux x64, and Linux arm64 BtbN builds; its immutable URL and SHA-256 are configured as repository variables, and the release workflow successfully attaches and checksums it.
- The source archive's embedded recipe and per-file manifest pass `node script/windows-source-bundle.mjs --verify`, and a maintainer has audited the collected linked-library sources against the binary configuration before publishing the draft.

## Product evidence

- A fresh administrator can complete standalone setup, connect Jellyfin, browse media, create a finite VOD URL, seek, stop, restart, and delete the session using only the documented workflow.
- A fresh administrator can create a live channel, publish from OBS, obtain the clean relay URL, reconnect the publisher, and stop the channel.
- A multi-host operator can enroll each role, bind Jellyfin only to selected source workers, preview placement, observe one coalesced encode, drain an edge, and recover after controller restart.
- The dashboard completes keyboard, mobile, screen-reader-name, focus, empty-state, error-state, and browser-console QA.
- Default H.264/AAC VOD and live URLs pass the checked-in VRChat PC matrix over trusted HTTPS. Quest evidence is recorded separately and support is claimed only after a real Quest passes.

## Release mechanics

- Update `CHANGELOG.md`, compatibility evidence, implementation status, runtime manifest, and upgrade notes.
- Create the version tag only after the candidate commit has passed every gate. The release workflow reruns CI, distributed acceptance, and high/critical security scanning before building artifacts.
- Verify artifact checksums, SBOM/provenance, install each final artifact, and perform one post-package VRChat smoke test before marking the GitHub release non-prerelease.
- Verify `/api/v1/health`, the dashboard, OCI labels, Helm app version, macOS DMG/app/LaunchDaemon metadata, and Windows installer metadata all report the normalized release tag.
- Publish known limitations prominently. Experimental codecs and delivery methods remain labelled experimental until recorded VRChat evidence promotes them.

The public repository may be opened after the feature-complete release-candidate gate passes, before the supported-v1 target-environment gates are complete, provided the README and implementation status make that distinction explicit. A private development remote may exist earlier. “Feature complete” means the documented v1 scope is implemented; “released” additionally requires every target-environment and real-client gate above.
