# Provider extensions

Implement the `MediaProvider` port and register it in the composition root. An adapter must authenticate, validate, browse, map item details, resolve an original source, open ranged source reads, and optionally report playback. Optional behavior is advertised through capabilities. The domain/application provider identifier is vendor-neutral, but the current public setup, sign-in, agent contract, and dashboard flows are explicitly Jellyfin-specific; a new provider must integrate those boundaries rather than relying on adapter registration alone.

Provider-specific DTOs stay inside the adapter. Public schemas use stable provider-scoped item IDs, source fingerprints, and neutral track/version models. Contract tests should run against both the new adapter and an in-memory fake before registration.
