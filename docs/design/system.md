# Dashboard design system

The implemented Svelte dashboard is the current visual reference. Historical
mockups were removed before repository publication because they no longer
matched the product and contained endpoint-, token-, or media-shaped sample
data.

- Background: near-black blue-gray, with open table and form bands.
- Surfaces: one step lighter than the background; no glass or floating card grid.
- Accent: restrained cyan for selection and primary actions.
- Semantics: green for healthy/active, amber for queues/warnings, red for errors.
- Geometry: one-pixel dividers and modest 8–10 px radii.
- Typography: compact technical sans; deliberate 12–14 px control chrome and
  24–30 px page titles.
- Layout: 228 px navigation, flexible content, 330–350 px activity/summary rail,
  and an optional bottom capacity band.
- Icons: consistent outline icons around 18 px with approximately 1.75 px strokes.
- Motion: 140–180 ms state transitions, disabled under reduced-motion preference.

All visible text and controls remain code-native. Any future publication
screenshot must use synthetic neutral fixtures and must not expose credentials,
playback or join tokens, private addresses, private paths, or real media.
