# Dashboard design systems

## Administrator dashboard

The Luma administrator dashboard is canonical under `/dashboard/*`. The retired Nova routes and
the former `/new/*` preview namespace are removed rather than retained as compatibility aliases.
A separate Luma user portal lives at
`/portal/*`. The base URL sends a normal session to the dashboard until the user
portal is configured, then to the portal. The interface uses a shadcn-svelte registry rooted at
`apps/web/src/lib/new-ui` with neutral colors and charts, Lucide icons, the
default radius, solid menus with subtle accents, and a self-hosted Inter family
that is scoped to the application.

The administrator interface deliberately reuses the existing API facade, generated client,
contracts, domain types, and administrator authentication session. Its UI
system/light/dark preference lives in `localStorage`. Theme variables are scoped at the document
root so portalled components inherit them consistently.

All visual treatment comes from the generated Luma primitives and the checked-in
theme variables. The Sessions concept is an information-architecture guide only:
it identifies the grouped navigation, header, metrics, controls, responsive data
views, details, and optional activity rail, but it is not a source for spacing,
dimensions, typography, colors, shadows, or interaction styling.

The administrator dashboard mirrors Sessions, Library, Live, New Relay, Cluster, Profiles,
profile creation, Compatibility, System, Settings, Login, and Setup. Below `md`,
the Sidebar becomes a Sheet and dense tables become Card summaries.

The user portal intentionally has a smaller surface: Jellyfin login, active links first, explicit
movie/show search, a show-to-season-to-episode picker, provider artwork, administrator-approved
profile selection, relay-link creation/copying, and removal of the signed-in user's own links.
Discovery remains empty until a search is submitted. Provider endpoint and profile policy live in
administrator Settings. The portal does not expose cluster placement, encoding internals, live
ingest, compatibility evidence, tokens, or runtime configuration.

All visible text and controls remain code-native. Any future publication
screenshot must use synthetic neutral fixtures and must not expose credentials,
playback or join tokens, private addresses, private paths, or real media.
