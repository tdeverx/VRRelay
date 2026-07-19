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

The main sidebar follows the shadcn collapsible-to-icons pattern and is split into User and Admin
groups. User contains Jellyfin discovery, Live, and Sessions. Admin exposes each permitted
destination directly: People & access, Connections, Profiles, Network, Runtime, API access, Nodes,
Storage & routing, Jobs & cache, and Diagnostics. There are no secondary navigation rails,
segmented page switchers, or Settings/System overview routes. The account menu occupies the
sidebar header and the theme control occupies the application header. Sessions shows personal
relay links and live playback to users and the system-wide view to operators. Dense tables become
Card summaries on small screens. Long configuration flows use the existing stepper without
introducing another navigation model.

The sign-in screen presents one Jellyfin username/password form. Submitting the configured local
recovery password with an empty username enters recovery-owner administration without advertising
a separate recovery mode in the interface.

All visible text and controls remain code-native. Any future publication
screenshot must use synthetic neutral fixtures and must not expose credentials,
playback or join tokens, private addresses, private paths, or real media.
