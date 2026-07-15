# VRRelay architecture

VRRelay is a centralized media relay, not peer-to-peer software. A Jellyfin VOD request follows this path:

```text
Jellyfin original source → bound source worker → FFmpeg → ObjectStore → edge disk cache → VRChat viewers
```

An OBS live request follows this path:

```text
OBS (RTMP/SRT/WHIP) → ingest origin / one normalizer → one pull per active edge → HLS viewers
```

One session/profile/window shares the same encoder jobs and segment cache. A simultaneous request for an identical segment joins the existing job. Independent seeks into different uncached windows can require separate bounded workers. Viewers never connect to one another; the relay host carries viewer egress.

## Boundaries

- `packages/domain` contains provider-neutral entities and validation only.
- `packages/application` owns use cases and ports. It knows no Jellyfin, FFmpeg, HTTP, database, or platform DTOs.
- `packages/adapters` implements Jellyfin, FFmpeg, SQLite/PostgreSQL, filesystem/S3/Azure/GCS object storage, Valkey coordination, platform secret stores, and network policy.
- `apps/relay` composes adapters and exposes `/api/v1`, `/play`, and internal loopback routes.
- `apps/web` consumes the versioned API. It does not import adapter types.
- `apps/macos` and `apps/windows` are service controllers and dashboard shells; relay business logic remains in TypeScript.

## Cluster roles

- The controller owns the API, dashboard, scheduler, enrollment, and edge director.
- Source workers are the only nodes allowed to hold provider credentials and transcode VOD.
- Ingest origins receive and optionally normalize one OBS publisher stream.
- Edges restore deterministic VOD objects into a local disk cache and proxy live paths on demand. Viewers never exchange media with one another.

Standalone mode implements the same ports with SQLite, memory coordination, and the local filesystem. Cluster mode substitutes PostgreSQL, Valkey, and any configured object-store adapter without changing domain models.

Plex or Emby support is added by implementing `MediaProvider`. New delivery engines implement `Transcoder` or a future delivery port without changing public provider models.

## VOD timeline

The HLS manifest is finite on its first response: it declares `PLAYLIST-TYPE:VOD`, every planned segment duration, and `ENDLIST`. This gives a compatible player a finite duration and seekable segment timeline. The player maintains its own current position; that value is not supplied by the manifest. VRRelay does not synchronize viewers. A VRChat world distributes the URL and playback time and seeks clients as needed.

No permanent alternate rendition is generated. Segments are created on demand, written atomically, reused temporarily, and evicted after idle expiry. Pinned sessions keep their playback URL and configuration, not media data or workers.

See the [code map](code-map.md) for entry points and change boundaries.
