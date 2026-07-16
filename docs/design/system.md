# Dashboard design systems

## Luma preview

The replacement administrator dashboard is available under `/dashboard/*`, with
`/new/*` retained as its review alias. A separate Luma user portal lives at
`/portal/*`. The base URL sends a normal session to the dashboard until the user
portal is configured, then to the portal; choosing the legacy interface suppresses
that redirect for the current browser session. The Luma routes use an isolated
shadcn-svelte registry rooted at
`apps/web/src/lib/new-ui` with neutral colors and charts, Lucide icons, the
default radius, solid menus with subtle accents, and a self-hosted Inter family
that is scoped to the preview.

The administrator interface deliberately reuses the existing API facade, generated client,
contracts, domain types, and administrator authentication session. Its UI
selection lives in `sessionStorage`, while the system/light/dark preference
lives in `localStorage`. New-route theme variables are scoped at
`html[data-ui='new']` so portalled components inherit them without affecting the
legacy routes.

All visual treatment comes from the generated Luma primitives and the checked-in
theme variables. The Sessions concept is an information-architecture guide only:
it identifies the grouped navigation, header, metrics, controls, responsive data
views, details, and optional activity rail, but it is not a source for spacing,
dimensions, typography, colors, shadows, or interaction styling.

The administrator dashboard mirrors Sessions, Library, Live, New Relay, Cluster, Profiles,
profile creation, Compatibility, System, Settings, Login, and Setup. Below `md`,
the Sidebar becomes a Sheet and dense tables become Card summaries. The legacy
interface remains canonical until a separate, explicit visual and workflow
approval authorizes cutover.

The user portal intentionally has a smaller surface: Jellyfin login, active links first, explicit
movie/show search, a show-to-season-to-episode picker, provider artwork, administrator-approved
profile selection, relay-link creation/copying, and removal of the signed-in user's own links.
Discovery remains empty until a search is submitted. Provider endpoint and profile policy live in
administrator Settings. The portal does not expose cluster placement, encoding internals, live
ingest, compatibility evidence, tokens, or runtime configuration.

## Legacy Nova interface

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
