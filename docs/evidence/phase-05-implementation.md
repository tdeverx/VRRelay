# Phase 5 implementation checkpoint — media profile truthfulness

Date: 2026-07-15

This is a build-first implementation checkpoint for Phase 5. It is not final
media-matrix, real VRChat, deployment, or release-candidate evidence.

## Scope completed

- New profile revisions now start as experimental; manually submitted verified
  revisions are rejected until compatibility evidence promotes them through a
  later workflow.
- Profile creation rejects delivery and processing shapes the runtime cannot
  currently serve:
  - low-latency delivery modes;
  - RTSP and HTTP MPEG-TS delivery;
  - HLS event playlists;
  - mismatched HLS container and segment-type pairs;
  - direct fragmented-MP4 output;
  - passthrough-policy profiles.
- The dashboard profile form now narrows delivery choices to implemented shapes:
  HLS with matching MPEG-TS or fMP4 segment settings. The direct fragmented-MP4
  choice described by the original checkpoint was removed during the 2026-07-25
  audit remediation because it bypassed admission and had no cluster delivery path.
- Compatibility policy and implementation-status documentation now distinguish
  blocked schema-only outputs from experimental codecs and processing options
  that still require retained matrix evidence.

## Lean guardrails run

Runtime used locally:

- Node: `v22.22.3`
- npm: `10.9.8`

The later combined closeout passed the pinned Node `22.23.1` `npm run ci` gate:
395 tests passed, 23 intentional skips, all checks and builds passed, and the
npm audit reported zero vulnerabilities.

Commands:

```text
npx vitest run packages/application/src/services.test.ts -t "profile lifecycle"
npm run format:check
npm run check
npm run lint
npm run build:packages
npm run build --workspace @vrrelay/web
```

Result: all commands passed.

## Deferred to final high-pass verification

- Media matrix evidence for H.265, AV1, copy codecs, hardware-specific encoders,
  tone mapping, subtitle burn-in, fMP4 HLS concurrency, corrupt-input
  behavior, and dual PC/Quest output claims.
- Real VRChat PC HTTPS compatibility evidence and any Quest compatibility
  evidence separately collected on real hardware.
