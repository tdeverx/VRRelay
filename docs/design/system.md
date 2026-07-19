# Dashboard design systems

## Unified dashboard

The Luma dashboard is canonical under `/dashboard/*`. Retired interfaces and the former portal are
removed rather than retained as compatibility aliases. Jellyfin users, operators, administrators,
and owners share one shell whose navigation is filtered by server-issued permissions. The interface
uses a shadcn-svelte registry rooted at
`apps/web/src/lib/new-ui` with neutral colors and charts, Lucide icons, the
default radius, solid menus with subtle accents, and a self-hosted Inter family
that is scoped to the application.

The interface deliberately reuses the existing API facade, generated client, contracts, domain
types, and unified authentication session. Its UI
system/light/dark preference lives in `localStorage`. Theme variables are scoped at the document
root so portalled components inherit them consistently.

All visual treatment comes from the generated Luma primitives and the checked-in
theme variables. The Sessions concept is an information-architecture guide only:
it identifies the grouped navigation, header, metrics, controls, responsive data
views, details, and optional activity rail, but it is not a source for spacing,
dimensions, typography, colors, shadows, or interaction styling.

The main navigation contains Home for personal Jellyfin discovery, Live and Sessions for every
signed-in user, and role-gated System and Settings destinations. The account menu occupies the
sidebar header and the theme control occupies the application header. Sessions shows personal
relay links and live playback to users and the system-wide view to operators. Settings uses a
persistent secondary sidebar grouping Overview, People & access, API access, Connections,
Profiles, Network, and Runtime; below `md`, that sidebar becomes a select control. System remains a
landing hub for Nodes, Storage & routing, Jobs & cache, and Diagnostics. Dense tables become Card
summaries on small screens. Long configuration flows use the existing stepper and responsive
tab/select patterns rather than introducing another navigation model.

All visible text and controls remain code-native. Any future publication
screenshot must use synthetic neutral fixtures and must not expose credentials,
playback or join tokens, private addresses, private paths, or real media.
