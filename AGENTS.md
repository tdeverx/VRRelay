# Repository instructions for automated contributors

Read `CONTRIBUTING.md`, `docs/architecture/overview.md`, and `docs/architecture/security.md` before editing.

- Preserve provider-neutral boundaries. `packages/domain` and `packages/application` must not import Jellyfin, FFmpeg, MediaMTX, database, HTTP-server, cloud-vendor, or platform DTOs.
- Never write secrets, private URLs, playback tokens, certificates, or real media into the repository, test output, screenshots, or logs.
- Do not construct shell commands from user input. Media settings must remain structured and validated.
- Do not hand-edit `apps/web/src/lib/generated/vrrelay-api`; edit OpenAPI and run `npm run generate:api`.
- Keep H.264/yuv420p/AAC MPEG-TS HLS as the production default unless checked-in VRChat evidence supports a change.
- Preserve standalone mode when changing cluster code.
- Use `apply_patch` for intentional source edits, avoid unrelated formatting churn, and do not overwrite user changes.
- Run `npm run ci` for repository changes. Also run the platform/deployment checks listed in `CONTRIBUTING.md` when relevant.
- Update documentation and `CHANGELOG.md` for user-visible behavior.
