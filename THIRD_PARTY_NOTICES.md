# Third-party notices

VRRelay is distributed under GPL-3.0-or-later and incorporates or bundles third-party software under compatible licenses. Exact bundled runtime versions, upstream sources, licenses, and checksums are recorded in `deploy/runtime-manifest.json`.

Notable runtime and source dependencies include Node.js, FFmpeg, MediaMTX, Electron, WinSW, SvelteKit, Svelte, Fastify, Zod, shadcn-svelte/Bits UI primitives, SQLite, PostgreSQL clients, Valkey/Redis clients, and cloud object-storage SDKs. Their own copyright notices and license terms continue to apply.

Release artifacts should include this file, `LICENSE`, the runtime manifest, the generated runtime provenance, an SBOM, and checksums. Dependency updates must preserve license metadata and regenerate the SBOM in CI. A release maintainer must also make the corresponding source and build instructions for bundled GPL binaries available with the release; a binary download link alone is not treated as source compliance.
