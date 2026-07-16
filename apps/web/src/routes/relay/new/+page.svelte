<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    AlertTriangle,
    ArrowLeft,
    Check,
    ChevronDown,
    Film,
    Info,
    LoaderCircle,
    Search,
    Settings2,
    Sparkles,
    Tv
  } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type {
    ClusterNode,
    MediaItem,
    PlatformMode,
    ProfileRevision,
    PublicProviderConnection
  } from '@vrrelay/domain';
  import AppShell from '$lib/components/AppShell.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';
  import * as Select from '$lib/components/ui/select';
  import * as Field from '$lib/components/ui/field';
  import * as Alert from '$lib/components/ui/alert';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import { Progress } from '$lib/components/ui/progress';
  import { ToggleGroup, ToggleGroupItem } from '$lib/components/ui/toggle-group';
  import { formatBitrate, formatDuration } from '$lib/utils';

  type MediaMode = 'movies' | 'shows';

  let providers = $state<PublicProviderConnection[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let nodes = $state<Array<ClusterNode & { agent: { connected: boolean; connectedAt?: string } }>>(
    []
  );
  let results = $state<MediaItem[]>([]);
  let selected = $state<MediaItem | null>(null);
  let selectedSeries = $state<MediaItem | null>(null);
  let selectedSeason = $state<MediaItem | null>(null);
  let seasons = $state<MediaItem[]>([]);
  let episodes = $state<MediaItem[]>([]);
  let mediaMode = $state<MediaMode>('movies');
  let providerId = $state('');
  let profileKey = $state('');
  let platformMode = $state<PlatformMode>('universal');
  let audioTrackId = $state('');
  let subtitleTrackId = $state('none');
  let query = $state('');
  let loading = $state(true);
  let searching = $state(false);
  let hierarchyLoading = $state(false);
  let creating = $state(false);
  let pinned = $state(false);
  let reportActivity = $state(true);
  let placementPolicy = $state<'local' | 'hosted' | 'auto'>('auto');
  let preferredRegion = $state('');
  let preferredNodeId = $state('');
  let placementLocked = $state(false);
  let placementPreview = $state<{ node?: ClusterNode | null; reason: string } | null>(null);
  let placementLoading = $state(false);
  let placementError = $state('');
  let nodeLoadError = $state('');
  let advancedOpen = $state(false);
  let placementRequest = 0;

  let currentProfile = $derived(
    profiles.find((profile) => `${profile.profileId}:${profile.revision}` === profileKey)
  );
  let provider = $derived(providers.find((item) => item.id === providerId));
  let eligibleNodes = $derived(
    currentProfile
      ? nodes.filter(
          (node) =>
            node.state === 'online' &&
            node.agent.connected &&
            node.roles.includes('source-worker') &&
            node.capabilities.encoders.includes(currentProfile.video.encoder) &&
            node.capabilities.providerIds.includes(providerId)
        )
      : []
  );
  let regions = $derived([...new Set(eligibleNodes.map((node) => node.region))].sort());
  let preferredNode = $derived(eligibleNodes.find((node) => node.id === preferredNodeId) ?? null);
  let step = $derived(
    !selected
      ? 1
      : !audioTrackId && (selected.audioTracks?.length ?? 0) > 0
        ? 2
        : !currentProfile
          ? 3
          : 4
  );
  let placementReady = $derived(
    placementPolicy === 'local' ||
      (!placementLoading && !placementError && Boolean(placementPreview?.node))
  );
  let formReady = $derived(Boolean(selected && currentProfile && provider));
  let ready = $derived(formReady && placementReady);

  onMount(load);

  $effect(() => {
    void [
      loading,
      providerId,
      profileKey,
      placementPolicy,
      preferredRegion,
      preferredNodeId,
      placementLocked
    ];
    if (!loading) void refreshPlacement();
  });

  async function load() {
    try {
      const [providerResult, profileResult] = await Promise.all([api.providers(), api.profiles()]);
      providers = providerResult.items;
      profiles = profileResult.items.filter(
        (profile) => !profile.disabledReason && profile.delivery.playlistType === 'vod'
      );
      providerId = providers[0]?.id ?? '';
      const defaultProfile =
        profiles.find(
          (profile) => profile.platform === 'universal' && profile.delivery.method === 'hls'
        ) ?? profiles[0];
      if (defaultProfile) {
        profileKey = `${defaultProfile.profileId}:${defaultProfile.revision}`;
        platformMode = defaultProfile.platform;
      }
      try {
        nodes = (await api.clusterNodes()).items;
      } catch (error) {
        nodeLoadError =
          error instanceof Error ? error.message : 'Could not load eligible cluster workers.';
      }
      if (providerId) await searchCatalog();
    } catch (error) {
      if (isAuthenticatedError(error)) return goto('/login');
      toast.error(error instanceof Error ? error.message : 'Could not prepare the relay form.');
    } finally {
      loading = false;
    }
  }

  async function searchCatalog() {
    if (!providerId) return;
    clearMediaSelection();
    clearShowHierarchy();
    searching = true;
    try {
      results = (
        await api.catalog(providerId, {
          search: query || undefined,
          kinds: [mediaMode === 'movies' ? 'Movie' : 'Series'],
          limit: 24
        })
      ).items;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not search the catalog.');
    } finally {
      searching = false;
    }
  }

  async function setProvider(value: string) {
    providerId = value;
    clearMediaSelection();
    clearShowHierarchy();
    preferredNodeId = '';
    placementLocked = false;
    await searchCatalog();
  }

  async function setMediaMode(value: string) {
    if (value !== 'movies' && value !== 'shows') return;
    mediaMode = value;
    await searchCatalog();
  }

  function clearMediaSelection() {
    selected = null;
    audioTrackId = '';
    subtitleTrackId = 'none';
  }

  function clearShowHierarchy() {
    selectedSeries = null;
    selectedSeason = null;
    seasons = [];
    episodes = [];
  }

  async function choose(item: MediaItem) {
    try {
      selected = await api.item(item.providerId, item.id);
      audioTrackId =
        selected.audioTracks?.find((track) => track.isDefault)?.id ??
        selected.audioTracks?.[0]?.id ??
        '';
      subtitleTrackId = 'none';
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load media details.');
    }
  }

  async function chooseSeries(item: MediaItem) {
    clearMediaSelection();
    selectedSeries = item;
    selectedSeason = null;
    seasons = [];
    episodes = [];
    hierarchyLoading = true;
    try {
      seasons = (
        await api.catalog(item.providerId, { parentId: item.id, kinds: ['Season'], limit: 200 })
      ).items;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load seasons.');
    } finally {
      hierarchyLoading = false;
    }
  }

  async function chooseSeason(value: string) {
    const season = seasons.find((item) => item.id === value);
    if (!season) return;
    clearMediaSelection();
    selectedSeason = season;
    episodes = [];
    hierarchyLoading = true;
    try {
      episodes = (
        await api.catalog(season.providerId, {
          parentId: season.id,
          kinds: ['Episode'],
          limit: 200
        })
      ).items;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load episodes.');
    } finally {
      hierarchyLoading = false;
    }
  }

  function episodeLabel(item: MediaItem): string {
    const number = item.indexNumber === undefined ? '' : `E${item.indexNumber}`;
    const season = item.parentIndexNumber === undefined ? '' : `S${item.parentIndexNumber}`;
    const prefix = `${season}${number}`;
    return prefix ? `${prefix} · ${item.name}` : item.name;
  }

  function setProfile(value: string) {
    profileKey = value;
    const profile = profiles.find((item) => `${item.profileId}:${item.revision}` === value);
    if (profile) platformMode = profile.platform;
    if (preferredNodeId && !eligibleNodes.some((node) => node.id === preferredNodeId)) {
      preferredNodeId = '';
      placementLocked = false;
    }
  }

  function setPlacementPolicy(value: string) {
    if (value !== 'auto' && value !== 'hosted' && value !== 'local') return;
    placementPolicy = value;
    if (value === 'local') {
      preferredRegion = '';
      preferredNodeId = '';
      placementLocked = false;
    }
  }

  function setPreferredRegion(value: string) {
    preferredRegion = value === '__any__' ? '' : value;
    if (preferredNode && preferredNode.region !== preferredRegion && preferredRegion) {
      preferredNodeId = '';
      placementLocked = false;
    }
  }

  function setPreferredNode(value: string) {
    preferredNodeId = value === '__scheduler__' ? '' : value;
    placementLocked = Boolean(preferredNodeId);
    const node = eligibleNodes.find((item) => item.id === preferredNodeId);
    if (node) preferredRegion = node.region;
  }

  function setPlacementLocked(value: boolean) {
    placementLocked = value && Boolean(preferredNodeId);
    if (!placementLocked) preferredNodeId = '';
  }

  function placementReason(reason: string): string {
    if (reason === 'preferred-node') return 'The selected worker is eligible and locked.';
    if (reason === 'preferred-region')
      return 'Selected for compatible capacity in the preferred region.';
    if (reason === 'hosted-capacity') return 'Selected from compatible hosted capacity.';
    if (reason === 'auto-capacity') return 'Selected from the least-loaded compatible capacity.';
    if (reason === 'preferred-node-unavailable')
      return 'The selected worker is no longer online or compatible with this provider and profile.';
    if (reason === 'no-compatible-source-worker')
      return 'No online source worker has both the selected provider and required encoder.';
    return reason.replaceAll('-', ' ');
  }

  async function refreshPlacement() {
    const requestId = ++placementRequest;
    const profile = currentProfile;
    placementError = '';

    if (placementPolicy === 'local') {
      const localPlacement: { node?: ClusterNode | null; reason: string } = {
        reason: 'local-runtime'
      };
      placementPreview = localPlacement;
      placementLoading = false;
      return localPlacement;
    }
    if (!profile || !providerId) {
      placementPreview = null;
      placementLoading = false;
      return null;
    }

    placementLoading = true;
    placementPreview = null;
    try {
      const request: Parameters<typeof api.previewPlacement>[0] = {
        providerId,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        placementPolicy,
        ...(placementLocked && preferredNodeId ? { preferredNodeId } : {}),
        ...(preferredRegion ? { preferredRegion } : {})
      };
      const result = await api.previewPlacement(request);
      if (requestId !== placementRequest) return null;
      placementPreview = result;
      return result;
    } catch (error) {
      if (requestId !== placementRequest) return null;
      placementError =
        error instanceof Error ? error.message : 'Could not preview placement for this relay.';
      return null;
    } finally {
      if (requestId === placementRequest) placementLoading = false;
    }
  }

  async function createRelay() {
    if (!selected || !currentProfile) return;
    creating = true;
    try {
      if (placementPolicy !== 'local') {
        const placement = await refreshPlacement();
        if (!placement?.node) {
          toast.error('Placement is unavailable', {
            description: 'Review the placement reason before creating this relay.'
          });
          return;
        }
      }
      const session = await api.createVodSession({
        name: selected.name,
        source: {
          providerId: selected.providerId,
          itemId: selected.id,
          versionId: selected.versions?.[0]?.id,
          audioTrackId: audioTrackId || undefined,
          subtitleTrackId: subtitleTrackId === 'none' ? undefined : subtitleTrackId
        },
        profileId: currentProfile.profileId,
        profileRevision: currentProfile.revision,
        platformMode,
        placementPolicy,
        preferredNodeId: placementLocked && preferredNodeId ? preferredNodeId : undefined,
        preferredRegion: preferredRegion.trim() || undefined,
        pinned,
        reportActivity
      });
      toast.success('Relay ready', { description: 'The playback URL has been generated.' });
      await goto(`/?session=${session.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create the relay.');
    } finally {
      creating = false;
    }
  }
</script>

<AppShell active="sessions">
  <div class="relay-page">
    <header>
      <Button variant="ghost" size="icon" href="/" aria-label="Back to sessions"
        ><ArrowLeft /></Button
      >
      <div>
        <h1>New relay</h1>
        <p>Create a finite, seekable URL from Jellyfin media.</p>
      </div>
    </header>

    <div class="workspace">
      <nav class="steps" aria-label="Relay creation progress">
        {#each [['Source', 'Choose Jellyfin media'], ['Tracks', 'Audio and subtitles'], ['Output', 'Playback profile'], ['Review', 'Create relay']] as item, index}
          <div class:current={step === index + 1} class:complete={step > index + 1}>
            <span
              >{#if step > index + 1}<Check />{:else}{index + 1}{/if}</span
            >
            <div><strong>{item[0]}</strong><small>{item[1]}</small></div>
          </div>
        {/each}
      </nav>

      <main>
        <section class="form-section">
          <div class="section-title">
            <span>01</span>
            <div>
              <h2>Source</h2>
              <p>Select the original media VRRelay should process.</p>
            </div>
          </div>
          {#if providers.length === 0 && !loading}
            <Alert.Root
              ><AlertTriangle /><Alert.Title>No provider connected</Alert.Title><Alert.Description
                >Add Jellyfin in Settings before creating a VOD relay.</Alert.Description
              ></Alert.Root
            >
            <Button href="/settings">Open settings</Button>
          {:else}
            <Field.Field>
              <Field.FieldLabel>Media provider</Field.FieldLabel>
              <Select.Root
                type="single"
                value={providerId}
                onValueChange={(value) => void setProvider(value ?? '')}
              >
                <Select.Trigger class="w-full">{provider?.name ?? 'Select provider'}</Select.Trigger
                >
                <Select.Content
                  ><Select.Group
                    >{#each providers as item}<Select.Item value={item.id} label={item.name}
                        >{item.name}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                >
              </Select.Root>
            </Field.Field>
            <div class="media-mode">
              <span>Browse</span>
              <ToggleGroup
                type="single"
                value={mediaMode}
                variant="outline"
                onValueChange={(value) => void setMediaMode(value ?? '')}
                aria-label="Media type"
              >
                <ToggleGroupItem value="movies" aria-label="Movies"><Film />Movies</ToggleGroupItem>
                <ToggleGroupItem value="shows" aria-label="Shows"><Tv />Shows</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <form
              class="search"
              onsubmit={(event) => {
                event.preventDefault();
                void searchCatalog();
              }}
            >
              <Search /><Input
                bind:value={query}
                placeholder={mediaMode === 'movies' ? 'Search movies…' : 'Search shows…'}
                aria-label="Search media"
              />
              <Button type="submit" variant="secondary" disabled={searching}
                >{searching ? 'Searching…' : 'Search'}</Button
              >
            </form>
            <div class="media-grid" aria-label="Media results">
              {#each results as item (item.id)}
                <button
                  class:selected={(mediaMode === 'movies' ? selected?.id : selectedSeries?.id) ===
                    item.id}
                  onclick={() => void (mediaMode === 'movies' ? choose(item) : chooseSeries(item))}
                >
                  <span class="poster"
                    >{#if item.imageUrl}<img src={item.imageUrl} alt="" />{:else}<Film />{/if}</span
                  >
                  <span
                    ><strong>{item.name}</strong><small
                      >{[item.productionYear, formatDuration(item.durationSeconds)]
                        .filter(Boolean)
                        .join(' · ') || item.kind}</small
                    ></span
                  >
                  {#if (mediaMode === 'movies' ? selected?.id : selectedSeries?.id) === item.id}<Check
                      class="selected-check"
                    />{/if}
                </button>
              {/each}
            </div>
            {#if !searching && results.length === 0}
              <p class="empty-results">No {mediaMode === 'movies' ? 'movies' : 'shows'} found.</p>
            {/if}
            {#if mediaMode === 'shows' && selectedSeries}
              <div class="show-picker" aria-busy={hierarchyLoading}>
                <Field.Field>
                  <Field.FieldLabel>Season</Field.FieldLabel>
                  <Select.Root
                    type="single"
                    value={selectedSeason?.id}
                    disabled={hierarchyLoading || seasons.length === 0}
                    onValueChange={(value) => void chooseSeason(value ?? '')}
                  >
                    <Select.Trigger class="w-full" aria-label="Season"
                      >{selectedSeason?.name ??
                        (hierarchyLoading ? 'Loading seasons…' : 'Select a season')}</Select.Trigger
                    >
                    <Select.Content
                      ><Select.Group
                        >{#each seasons as season}<Select.Item value={season.id} label={season.name}
                            >{season.name}</Select.Item
                          >{/each}</Select.Group
                      ></Select.Content
                    >
                  </Select.Root>
                  {#if !hierarchyLoading && seasons.length === 0}
                    <Field.FieldDescription
                      >No seasons are available for this show.</Field.FieldDescription
                    >
                  {/if}
                </Field.Field>
                <Field.Field>
                  <Field.FieldLabel>Episode</Field.FieldLabel>
                  <Select.Root
                    type="single"
                    value={selected?.id}
                    disabled={hierarchyLoading || !selectedSeason || episodes.length === 0}
                    onValueChange={(value) => {
                      const episode = episodes.find((item) => item.id === value);
                      if (episode) void choose(episode);
                    }}
                  >
                    <Select.Trigger class="w-full" aria-label="Episode"
                      >{selected
                        ? episodeLabel(selected)
                        : hierarchyLoading && selectedSeason
                          ? 'Loading episodes…'
                          : 'Select an episode'}</Select.Trigger
                    >
                    <Select.Content
                      ><Select.Group
                        >{#each episodes as episode}<Select.Item
                            value={episode.id}
                            label={episodeLabel(episode)}>{episodeLabel(episode)}</Select.Item
                          >{/each}</Select.Group
                      ></Select.Content
                    >
                  </Select.Root>
                  {#if selectedSeason && !hierarchyLoading && episodes.length === 0}
                    <Field.FieldDescription
                      >No episodes are available for this season.</Field.FieldDescription
                    >
                  {/if}
                </Field.Field>
              </div>
            {/if}
          {/if}
        </section>

        <section class="form-section" class:dimmed={!selected}>
          <div class="section-title">
            <span>02</span>
            <div>
              <h2>Tracks</h2>
              <p>Choose the source tracks before real-time transcoding.</p>
            </div>
          </div>
          <div class="two-column">
            <Field.Field>
              <Field.FieldLabel>Audio track</Field.FieldLabel>
              <Select.Root type="single" bind:value={audioTrackId} disabled={!selected}>
                <Select.Trigger class="w-full"
                  >{selected?.audioTracks?.find((track) => track.id === audioTrackId)?.title ??
                    'Default audio'}</Select.Trigger
                >
                <Select.Content
                  ><Select.Group
                    >{#each selected?.audioTracks ?? [] as track}<Select.Item
                        value={track.id}
                        label={track.title}>{track.title} · {track.codec ?? 'unknown'}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                >
              </Select.Root>
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel>Subtitles</Field.FieldLabel>
              <Select.Root type="single" bind:value={subtitleTrackId} disabled={!selected}>
                <Select.Trigger class="w-full"
                  >{subtitleTrackId === 'none'
                    ? 'Off'
                    : selected?.subtitleTracks?.find((track) => track.id === subtitleTrackId)
                        ?.title}</Select.Trigger
                >
                <Select.Content
                  ><Select.Group
                    ><Select.Item value="none" label="Off">Off</Select.Item
                    >{#each selected?.subtitleTracks ?? [] as track}<Select.Item
                        value={track.id}
                        label={track.title}>{track.title}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                >
              </Select.Root>
            </Field.Field>
          </div>
        </section>

        <section class="form-section">
          <div class="section-title">
            <span>03</span>
            <div>
              <h2>Output</h2>
              <p>Select a tested profile or an experimental delivery method.</p>
            </div>
          </div>
          <div class="two-column">
            <Field.Field>
              <Field.FieldLabel>Encoding profile</Field.FieldLabel>
              <Select.Root
                type="single"
                value={profileKey}
                onValueChange={(value) => setProfile(value ?? '')}
              >
                <Select.Trigger class="w-full"
                  >{currentProfile?.name ?? 'Select profile'}</Select.Trigger
                >
                <Select.Content
                  ><Select.Group
                    >{#each profiles as profile}<Select.Item
                        value={`${profile.profileId}:${profile.revision}`}
                        label={profile.name}>{profile.name}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                >
              </Select.Root>
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel>Platform mode</Field.FieldLabel>
              <Select.Root type="single" bind:value={platformMode}>
                <Select.Trigger class="w-full"
                  >{{
                    universal: 'Universal PC + Quest',
                    pc: 'PC optimized',
                    quest: 'Quest optimized',
                    dual: 'Dual output'
                  }[platformMode]}</Select.Trigger
                >
                <Select.Content
                  ><Select.Group
                    ><Select.Item value="universal" label="Universal PC + Quest"
                      >Universal PC + Quest</Select.Item
                    ><Select.Item value="pc" label="PC optimized">PC optimized</Select.Item
                    ><Select.Item value="quest" label="Quest optimized">Quest optimized</Select.Item
                    ><Select.Item value="dual" label="Dual output">Dual output</Select.Item
                    ></Select.Group
                  ></Select.Content
                >
              </Select.Root>
            </Field.Field>
          </div>
          <Collapsible.Root bind:open={advancedOpen}>
            <Collapsible.Trigger class="advanced-trigger"
              ><Settings2 />Advanced behavior<ChevronDown
                class={advancedOpen ? 'rotated' : ''}
              /></Collapsible.Trigger
            >
            <Collapsible.Content class="advanced-content">
              <label
                ><span
                  ><strong>Pin relay</strong><small
                    >Keep configuration and URL after idle cache cleanup.</small
                  ></span
                ><Switch bind:checked={pinned} /></label
              >
              <label
                ><span
                  ><strong>Report activity</strong><small
                    >Report playback activity to the connected provider.</small
                  ></span
                ><Switch bind:checked={reportActivity} /></label
              >
            </Collapsible.Content>
          </Collapsible.Root>

          <div class="placement-panel">
            <div class="placement-heading">
              <span
                ><strong>Placement preview</strong><small
                  >Confirm compatible capacity before creating the relay.</small
                ></span
              >
              <Badge
                variant={placementPolicy === 'local'
                  ? 'neutral'
                  : placementLoading
                    ? 'neutral'
                    : placementPreview?.node
                      ? 'success'
                      : 'destructive'}
                >{placementPolicy === 'local'
                  ? 'Local'
                  : placementLoading
                    ? 'Checking'
                    : placementPreview?.node
                      ? 'Eligible'
                      : 'Unavailable'}</Badge
              >
            </div>

            <div class="placement-controls">
              <Field.Field>
                <Field.FieldLabel>Placement policy</Field.FieldLabel>
                <Select.Root
                  type="single"
                  value={placementPolicy}
                  onValueChange={(value) => setPlacementPolicy(value ?? '')}
                >
                  <Select.Trigger class="w-full" aria-label="Placement policy"
                    >{{ auto: 'Automatic', local: 'This node', hosted: 'Cluster node' }[
                      placementPolicy
                    ]}</Select.Trigger
                  >
                  <Select.Content
                    ><Select.Group
                      ><Select.Item value="auto" label="Automatic">Automatic</Select.Item
                      ><Select.Item value="local" label="This node">This node</Select.Item
                      ><Select.Item value="hosted" label="Cluster node">Cluster node</Select.Item
                      ></Select.Group
                    ></Select.Content
                  >
                </Select.Root>
              </Field.Field>

              <Field.Field>
                <Field.FieldLabel>Preferred region</Field.FieldLabel>
                <Select.Root
                  type="single"
                  value={preferredRegion || '__any__'}
                  disabled={placementPolicy === 'local'}
                  onValueChange={(value) => setPreferredRegion(value ?? '__any__')}
                >
                  <Select.Trigger class="w-full" aria-label="Preferred region"
                    >{preferredRegion || 'Any region'}</Select.Trigger
                  >
                  <Select.Content
                    ><Select.Group
                      ><Select.Item value="__any__" label="Any region">Any region</Select.Item
                      >{#each regions as region}<Select.Item value={region} label={region}
                          >{region}</Select.Item
                        >{/each}</Select.Group
                    ></Select.Content
                  >
                </Select.Root>
              </Field.Field>

              <Field.Field>
                <Field.FieldLabel>Exact worker</Field.FieldLabel>
                <Select.Root
                  type="single"
                  value={preferredNodeId || '__scheduler__'}
                  disabled={placementPolicy === 'local'}
                  onValueChange={(value) => setPreferredNode(value ?? '__scheduler__')}
                >
                  <Select.Trigger
                    class="w-full"
                    aria-label="Exact eligible worker"
                    aria-describedby="placement-status"
                    >{preferredNode
                      ? `${preferredNode.name} · ${preferredNode.region}`
                      : 'Scheduler choice'}</Select.Trigger
                  >
                  <Select.Content
                    ><Select.Group
                      ><Select.Item value="__scheduler__" label="Scheduler choice"
                        >Scheduler choice</Select.Item
                      >{#each eligibleNodes as node}<Select.Item value={node.id} label={node.name}
                          >{node.name} · {node.region} · {node.capabilities.activeWorkers}/{node
                            .capabilities.maxWorkers} workers</Select.Item
                        >{/each}</Select.Group
                    ></Select.Content
                  >
                </Select.Root>
              </Field.Field>
            </div>

            <label class="placement-lock">
              <span
                ><strong>Lock placement</strong><small
                  >Selecting an exact worker prevents failover to another worker.</small
                ></span
              >
              <Switch
                checked={placementLocked}
                disabled={!preferredNodeId || placementPolicy === 'local'}
                aria-label="Lock placement to selected worker"
                onCheckedChange={setPlacementLocked}
              />
            </label>

            {#if nodeLoadError && placementPolicy !== 'local'}
              <p class="placement-note" role="status">
                Exact worker choices could not be loaded: {nodeLoadError} Scheduler preview remains available.
              </p>
            {/if}

            <div id="placement-status" class="placement-status" aria-live="polite">
              {#if placementPolicy === 'local'}
                <Alert.Root
                  ><Info /><Alert.Title>This runtime</Alert.Title><Alert.Description
                    >Standalone placement does not require a cluster worker.</Alert.Description
                  ></Alert.Root
                >
              {:else if placementLoading}
                <Alert.Root
                  ><LoaderCircle class="spin" /><Alert.Title>Checking placement</Alert.Title
                  ><Alert.Description
                    >Matching the provider and encoder against online source workers.</Alert.Description
                  ></Alert.Root
                >
              {:else if placementError}
                <Alert.Root variant="destructive"
                  ><AlertTriangle /><Alert.Title>Preview unavailable</Alert.Title><Alert.Description
                    >{placementError}</Alert.Description
                  ></Alert.Root
                >
              {:else if placementPreview?.node}
                <Alert.Root
                  ><Check /><Alert.Title>{placementPreview.node.name}</Alert.Title
                  ><Alert.Description
                    >{placementReason(placementPreview.reason)} Region {placementPreview.node
                      .region};
                    {placementPreview.node.capabilities.activeWorkers}/{placementPreview.node
                      .capabilities.maxWorkers} workers active. Reason: {placementPreview.reason}.</Alert.Description
                  ></Alert.Root
                >
              {:else}
                <Alert.Root variant="destructive"
                  ><AlertTriangle /><Alert.Title>Placement rejected</Alert.Title><Alert.Description
                    >{placementReason(placementPreview?.reason ?? 'no-compatible-source-worker')}
                    Reason: {placementPreview?.reason ??
                      'no-compatible-source-worker'}.</Alert.Description
                  ></Alert.Root
                >
              {/if}
            </div>
          </div>
        </section>
      </main>

      <aside class="summary">
        <div class="summary-header">
          <Sparkles />
          <div>
            <h2>Relay summary</h2>
            <p>Generated just in time</p>
          </div>
        </div>
        <Progress value={ready ? 100 : step * 24} />
        <dl>
          <div>
            <dt>Source</dt>
            <dd>{selected?.name ?? 'Not selected'}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(selected?.durationSeconds)}</dd>
          </div>
          <div>
            <dt>Video</dt>
            <dd>
              {currentProfile
                ? `${currentProfile.video.codec.toUpperCase()} · ${currentProfile.video.width}p`
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Audio</dt>
            <dd>
              {currentProfile
                ? `${currentProfile.audio.codec.toUpperCase()} · ${currentProfile.audio.channels} ch`
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Delivery</dt>
            <dd>{currentProfile?.delivery.method.replace('_', ' ').toUpperCase() ?? '—'}</dd>
          </div>
          <div>
            <dt>Placement</dt>
            <dd>
              {placementPolicy === 'local'
                ? 'This runtime'
                : placementLoading
                  ? 'Checking…'
                  : (placementPreview?.node?.name ?? 'Unavailable')}
            </dd>
          </div>
          <div>
            <dt>Bitrate</dt>
            <dd>{currentProfile ? formatBitrate(currentProfile.video.bitrateKbps) : '—'}</dd>
          </div>
        </dl>
        {#if provider?.securityNotice}<Alert.Root variant="destructive"
            ><AlertTriangle /><Alert.Title>Private HTTP connection</Alert.Title><Alert.Description
              >{provider.securityNotice}</Alert.Description
            ></Alert.Root
          >{/if}
        <Alert.Root
          ><Info /><Alert.Title
            >{ready
              ? 'Ready to create'
              : formReady && !placementReady
                ? 'Resolve placement before creating'
                : 'Complete the source selection'}</Alert.Title
          ><Alert.Description
            >{ready
              ? 'Encoding begins only when a player requests segments.'
              : formReady && !placementReady
                ? 'Creation stays disabled while placement is unavailable.'
                : 'No media is processed or stored yet.'}</Alert.Description
          ></Alert.Root
        >
        <div class="actions">
          <Button variant="outline" href="/">Cancel</Button><Button
            disabled={!ready || creating}
            onclick={() => void createRelay()}
            >{#if creating}<LoaderCircle class="spin" />{/if}Create relay</Button
          >
        </div>
      </aside>
    </div>
  </div>
</AppShell>

<style>
  .relay-page {
    min-height: 100%;
    padding: 32px 38px 48px;
  }
  .relay-page > header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 28px;
  }
  .relay-page h1 {
    font-size: 27px;
    letter-spacing: -0.025em;
  }
  .relay-page p {
    color: var(--muted-foreground);
    font-size: 13px;
  }
  .workspace {
    display: grid;
    grid-template-columns: 180px minmax(440px, 1fr) 310px;
    gap: 30px;
    align-items: start;
  }
  .steps {
    position: sticky;
    top: 24px;
    display: flex;
    flex-direction: column;
  }
  .steps > div {
    position: relative;
    display: flex;
    gap: 12px;
    min-height: 74px;
    color: var(--muted-foreground);
  }
  .steps > div:not(:last-child)::after {
    position: absolute;
    top: 30px;
    bottom: 0;
    left: 14px;
    width: 1px;
    background: var(--border);
    content: '';
  }
  .steps > div > span {
    z-index: 1;
    display: grid;
    width: 29px;
    height: 29px;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--background);
    font-size: 11px;
  }
  .steps :global(svg) {
    width: 14px;
  }
  .steps div div {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 4px;
  }
  .steps strong {
    font-size: 13px;
  }
  .steps small {
    font-size: 11px;
  }
  .steps .current {
    color: var(--foreground);
  }
  .steps .current > span {
    border-color: var(--primary);
    background: var(--primary);
    color: var(--primary-foreground);
  }
  .steps .complete > span {
    border-color: var(--success);
    color: var(--success);
  }
  main {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .form-section,
  .summary {
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--card);
  }
  .form-section {
    padding: 23px;
  }
  .form-section.dimmed {
    opacity: 0.58;
  }
  .section-title {
    display: flex;
    gap: 13px;
    margin-bottom: 20px;
  }
  .section-title > span {
    color: var(--primary);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    padding-top: 5px;
  }
  .section-title h2,
  .summary h2 {
    font-size: 16px;
  }
  .section-title p {
    margin-top: 3px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 14px 0;
  }
  .media-mode {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 14px;
  }
  .media-mode > span {
    color: var(--muted-foreground);
    font-size: 12px;
    font-weight: 500;
  }
  .media-mode :global(svg) {
    width: 15px;
  }
  .search > :global(svg) {
    position: absolute;
    width: 16px;
    margin-left: 11px;
    color: var(--muted-foreground);
  }
  .search :global(input) {
    padding-left: 35px;
  }
  .media-grid {
    display: grid;
    max-height: 315px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    overflow: auto;
  }
  .media-grid button {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-subtle);
    padding: 8px;
    text-align: left;
    color: var(--foreground);
  }
  .media-grid button:hover,
  .media-grid button.selected {
    border-color: color-mix(in oklab, var(--primary) 65%, var(--border));
    background: var(--surface-selected);
  }
  .poster {
    display: grid;
    width: 40px;
    height: 52px;
    flex: none;
    place-items: center;
    overflow: hidden;
    border-radius: 4px;
    background: var(--muted);
  }
  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .poster :global(svg) {
    width: 18px;
    color: var(--muted-foreground);
  }
  .media-grid button > span:nth-child(2) {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
  }
  .media-grid strong,
  .media-grid small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty-results {
    border: 1px dashed var(--border);
    border-radius: 7px;
    padding: 24px;
    text-align: center;
  }
  .show-picker {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-top: 16px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
  .media-grid strong {
    font-size: 12px;
  }
  .media-grid small {
    color: var(--muted-foreground);
    font-size: 10px;
  }
  :global(.selected-check) {
    position: absolute;
    top: 7px;
    right: 7px;
    width: 14px;
    color: var(--primary);
  }
  .two-column {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  .placement-panel {
    display: grid;
    gap: 14px;
    margin-top: 18px;
    border-top: 1px solid var(--border);
    padding-top: 18px;
  }
  .placement-heading,
  .placement-lock {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }
  .placement-heading > span,
  .placement-lock > span {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .placement-heading strong,
  .placement-lock strong {
    font-size: 12px;
  }
  .placement-heading small,
  .placement-lock small,
  .placement-note {
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .placement-controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  .placement-controls > :global([data-slot='field']:last-child) {
    grid-column: 1 / -1;
  }
  .placement-note {
    margin: 0;
  }
  .placement-status :global([data-slot='alert']) {
    margin: 0;
  }
  :global(.advanced-trigger) {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 9px;
    margin-top: 18px;
    border-top: 1px solid var(--border);
    padding: 16px 2px 0;
    color: var(--muted-foreground);
    font-size: 12px;
  }
  :global(.advanced-trigger svg) {
    width: 15px;
  }
  :global(.advanced-trigger svg:last-child) {
    margin-left: auto;
    transition: transform 0.15s;
  }
  :global(.advanced-trigger .rotated) {
    transform: rotate(180deg);
  }
  :global(.advanced-content) {
    display: grid;
    gap: 12px;
    padding-top: 16px;
  }
  :global(.advanced-content label) {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  :global(.advanced-content label span) {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  :global(.advanced-content strong) {
    font-size: 12px;
  }
  :global(.advanced-content small) {
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .summary {
    position: sticky;
    top: 24px;
    padding: 22px;
  }
  .summary-header {
    display: flex;
    align-items: center;
    gap: 11px;
    margin-bottom: 18px;
  }
  .summary-header > :global(svg) {
    width: 19px;
    color: var(--primary);
  }
  .summary-header p {
    margin-top: 2px;
    font-size: 11px;
  }
  .summary :global([data-slot='progress']) {
    margin-bottom: 24px;
  }
  .summary dl {
    display: flex;
    flex-direction: column;
    margin: 0 0 19px;
  }
  .summary dl div {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    border-bottom: 1px solid var(--border);
    padding: 11px 0;
    font-size: 11px;
  }
  .summary dt {
    color: var(--muted-foreground);
  }
  .summary dd {
    max-width: 170px;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: right;
    white-space: nowrap;
  }
  .summary :global([data-slot='alert']) {
    margin-top: 12px;
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1.25fr;
    gap: 8px;
    margin-top: 18px;
  }
  :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 1180px) {
    .workspace {
      grid-template-columns: 150px minmax(400px, 1fr);
    }
    .summary {
      position: static;
      grid-column: 2;
    }
  }
  @media (max-width: 760px) {
    .relay-page {
      padding: 22px 16px;
    }
    .workspace {
      display: block;
    }
    .steps {
      position: static;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      margin-bottom: 18px;
    }
    .steps > div {
      min-height: 58px;
    }
    .steps > div:not(:last-child)::after {
      display: none;
    }
    .steps small {
      display: none;
    }
    .workspace main {
      margin-bottom: 18px;
    }
    .two-column,
    .media-grid,
    .show-picker,
    .placement-controls {
      grid-template-columns: 1fr;
    }
    .summary {
      margin-top: 18px;
    }
  }
</style>
