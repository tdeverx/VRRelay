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
  - fragmented-MP4 profiles that do not use MP4 container, no segment output,
    and VOD playlist shape;
  - passthrough-policy profiles.
- The dashboard profile form now narrows delivery choices to implemented shapes:
  HLS with matching MPEG-TS or fMP4 segment settings, and direct fragmented MP4
  without segment output.
- Compatibility policy and implementation-status documentation now distinguish
  blocked schema-only outputs from experimental codecs and processing options
  that still require retained matrix evidence.

## Lean guardrails run

Runtime used locally:

- Node: `v22.22.3`
- npm: `10.9.8`

The repository pin is Node `22.23.1`; the pinned-runtime full gate remains part
of the final high-pass verification bundle.

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

- Full `npm run ci` under the checksum-verified pinned Node runtime.
- Media matrix evidence for H.265, AV1, copy codecs, hardware-specific encoders,
  tone mapping, subtitle burn-in, fMP4/fragmented-MP4 concurrency, corrupt-input
  behavior, and dual PC/Quest output claims.
- Real VRChat PC HTTPS compatibility evidence and any Quest compatibility
  evidence separately collected on real hardware.
