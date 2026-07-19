<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft, Check, Film, Search } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type {
    ClusterNode,
    MediaItem,
    PlatformMode,
    ProfileRevision,
    PublicProviderConnection
  } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import { adminRoute } from '#lib/new-ui/state.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Alert from '#lib/new-ui/components/ui/alert';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import { Progress } from '#lib/new-ui/components/ui/progress';
  import * as Select from '#lib/new-ui/components/ui/select';
  import * as Sheet from '#lib/new-ui/components/ui/sheet';
  import { Switch } from '#lib/new-ui/components/ui/switch';
  import * as ToggleGroup from '#lib/new-ui/components/ui/toggle-group';

  type MediaMode = 'movies' | 'shows';
  const steps = ['Source', 'Tracks', 'Output', 'Review'];
  let currentStep = $state(1);
  let providers = $state<PublicProviderConnection[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let nodes = $state<Array<ClusterNode & { agent: { connected: boolean; connectedAt?: string } }>>(
    []
  );
  let results = $state<MediaItem[]>([]);
  let seasons = $state<MediaItem[]>([]);
  let episodes = $state<MediaItem[]>([]);
  let selectedSeries = $state<MediaItem | null>(null);
  let selectedSeason = $state<MediaItem | null>(null);
  let selected = $state<MediaItem | null>(null);
  let providerId = $state('');
  let profileKey = $state('');
  let platformMode = $state<PlatformMode>('universal');
  let mediaMode = $state<MediaMode>('movies');
  let query = $state('');
  let audioTrackId = $state('');
  let subtitleTrackId = $state('none');
  let placementPolicy = $state<'local' | 'hosted' | 'auto'>('auto');
  let preferredRegion = $state('');
  let preferredNodeId = $state('');
  let placementLocked = $state(false);
  let placementPreview = $state<{ node?: ClusterNode | null; reason: string } | null>(null);
  let placementLoading = $state(false);
  let placementError = $state('');
  let loading = $state(true);
  let searching = $state(false);
  let creating = $state(false);
  let pinned = $state(false);
  let reportActivity = $state(true);
  let summaryOpen = $state(false);
  let placementRequest = 0;

  let currentProfile = $derived(
    profiles.find((profile) => `${profile.profileId}:${profile.revision}` === profileKey)
  );
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
  let placementReady = $derived(
    !placementLoading && !placementError && Boolean(placementPreview?.node)
  );

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
      providers = providerResult.items.filter((provider) => provider.authMode !== 'delegated');
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
      } catch {
        nodes = [];
      }
      if (providerId) await searchCatalog();
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(adminRoute(page.url.pathname, '/login'));
      toast.error(reason instanceof Error ? reason.message : 'Could not prepare relay form.');
    } finally {
      loading = false;
    }
  }

  async function searchCatalog() {
    if (!providerId) return;
    selected = null;
    selectedSeries = null;
    selectedSeason = null;
    seasons = [];
    episodes = [];
    searching = true;
    try {
      results = (
        await api.catalog(providerId, {
          search: query || undefined,
          kinds: [mediaMode === 'movies' ? 'Movie' : 'Series'],
          limit: 24
        })
      ).items;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not search catalog.');
    } finally {
      searching = false;
    }
  }

  async function choose(item: MediaItem) {
    try {
      selected = await api.item(item.providerId, item.id);
      audioTrackId =
        selected.audioTracks?.find((track) => track.isDefault)?.id ??
        selected.audioTracks?.[0]?.id ??
        '';
      subtitleTrackId = 'none';
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load media details.');
    }
  }

  async function chooseSeries(item: MediaItem) {
    selected = null;
    selectedSeries = item;
    selectedSeason = null;
    seasons = [];
    episodes = [];
    try {
      seasons = (
        await api.catalog(item.providerId, { parentId: item.id, kinds: ['Season'], limit: 200 })
      ).items;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load seasons.');
    }
  }

  async function chooseSeason(value: string) {
    const season = seasons.find((item) => item.id === value);
    if (!season) return;
    selected = null;
    selectedSeason = season;
    try {
      episodes = (
        await api.catalog(season.providerId, {
          parentId: season.id,
          kinds: ['Episode'],
          limit: 200
        })
      ).items;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load episodes.');
    }
  }

  function selectProfile(value: string) {
    profileKey = value;
    const profile = profiles.find((item) => `${item.profileId}:${item.revision}` === value);
    if (profile) platformMode = profile.platform;
    if (preferredNodeId && !eligibleNodes.some((node) => node.id === preferredNodeId)) {
      preferredNodeId = '';
      placementLocked = false;
    }
  }

  async function refreshPlacement() {
    const requestId = ++placementRequest;
    placementError = '';
    if (!currentProfile || !providerId) return null;
    placementLoading = true;
    placementPreview = null;
    try {
      const result = await api.previewPlacement({
        providerId,
        profileId: currentProfile.profileId,
        profileRevision: currentProfile.revision,
        placementPolicy,
        ...(placementLocked && preferredNodeId ? { preferredNodeId } : {}),
        ...(preferredRegion ? { preferredRegion } : {})
      });
      if (requestId === placementRequest) placementPreview = result;
      return result;
    } catch (reason) {
      if (requestId === placementRequest)
        placementError = reason instanceof Error ? reason.message : 'Could not preview placement.';
      return null;
    } finally {
      if (requestId === placementRequest) placementLoading = false;
    }
  }

  function canContinue() {
    if (currentStep === 1) return Boolean(selected);
    if (currentStep === 2) return Boolean(audioTrackId || !selected?.audioTracks?.length);
    if (currentStep === 3) return Boolean(currentProfile && placementReady);
    return true;
  }

  async function createRelay() {
    if (!selected || !currentProfile) return;
    creating = true;
    try {
      if (!(await refreshPlacement())?.node) return toast.error('Placement is unavailable.');
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
        preferredRegion: preferredRegion || undefined,
        pinned,
        reportActivity
      });
      toast.success('Relay ready.');
      await goto(`${adminRoute(page.url.pathname)}?session=${session.id}`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not create relay.');
    } finally {
      creating = false;
    }
  }
</script>

{#snippet Summary()}
  <div class="space-y-4 text-sm">
    <div>
      <span class="text-muted-foreground block text-xs">Source</span><strong
        >{selected?.name ?? 'Not selected'}</strong
      >
    </div>
    <div>
      <span class="text-muted-foreground block text-xs">Profile</span><strong
        >{currentProfile?.name ?? 'Not selected'}</strong
      >
    </div>
    <div>
      <span class="text-muted-foreground block text-xs">Platform</span><strong
        >{platformMode}</strong
      >
    </div>
    <div>
      <span class="text-muted-foreground block text-xs">Placement</span><strong
        >{placementPolicy === 'local'
          ? 'Local runtime'
          : (placementPreview?.node?.name ??
            (placementLoading ? 'Checking…' : 'Unavailable'))}</strong
      >
    </div>
  </div>
{/snippet}

<div class="min-h-full">
  <header class="flex items-center gap-3 border-b p-4 md:p-6">
    <Button
      variant="ghost"
      size="icon"
      href={adminRoute(page.url.pathname)}
      aria-label="Back to sessions"><ArrowLeft /></Button
    >
    <div class="min-w-0 flex-1">
      <h1 class="text-xl font-semibold">New relay</h1>
      <p class="text-muted-foreground text-sm">
        Create a finite, seekable URL from Jellyfin media.
      </p>
    </div>
    <Button class="md:hidden" variant="outline" onclick={() => (summaryOpen = true)}>Summary</Button
    >
  </header>
  <Progress
    value={(currentStep / steps.length) * 100}
    class="rounded-none md:hidden"
    aria-label="Relay creation progress"
  />
  <div class="grid md:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,1fr)_18rem]">
    <nav class="hidden border-r p-4 md:block" aria-label="Relay creation progress">
      <ol class="space-y-2">
        {#each steps as label, index}<li>
            <Button
              class="w-full justify-start"
              variant={currentStep === index + 1 ? 'secondary' : 'ghost'}
              disabled={index + 1 > currentStep}
              onclick={() => (currentStep = index + 1)}
              >{#if index + 1 < currentStep}<Check data-icon="inline-start" />{:else}<span
                  class="inline-grid size-4 place-items-center text-xs">{index + 1}</span
                >{/if}{label}</Button
            >
          </li>{/each}
      </ol>
    </nav>
    <main class="min-w-0 space-y-6 p-4 md:p-6">
      <div class="md:hidden">
        <span class="text-muted-foreground text-xs">Step {currentStep} of {steps.length}</span>
        <h2 class="text-xl font-semibold">{steps[currentStep - 1]}</h2>
      </div>
      {#if currentStep === 1}
        <div class="space-y-5">
          <div>
            <h2 class="text-xl font-semibold">Choose a source</h2>
            <p class="text-muted-foreground text-sm">
              Select a movie or episode from a connected provider.
            </p>
          </div>
          <div class="flex flex-col gap-3 lg:flex-row">
            <Select.Root
              type="single"
              value={providerId}
              onValueChange={(value) => {
                providerId = value ?? '';
                void searchCatalog();
              }}
              ><Select.Trigger class="w-full lg:w-56"
                >{providers.find((provider) => provider.id === providerId)?.name ??
                  'Provider'}</Select.Trigger
              ><Select.Content
                >{#each providers as provider}<Select.Item value={provider.id}
                    >{provider.name}</Select.Item
                  >{/each}</Select.Content
              ></Select.Root
            ><ToggleGroup.Root
              type="single"
              value={mediaMode}
              onValueChange={(value) => {
                if (value === 'movies' || value === 'shows') {
                  mediaMode = value;
                  void searchCatalog();
                }
              }}
              ><ToggleGroup.Item value="movies">Movies</ToggleGroup.Item><ToggleGroup.Item
                value="shows">Shows</ToggleGroup.Item
              ></ToggleGroup.Root
            >
            <form
              class="flex flex-1 gap-2"
              onsubmit={(event) => {
                event.preventDefault();
                void searchCatalog();
              }}
            >
              <label class="relative flex-1"
                ><Search
                  class="text-muted-foreground absolute start-3 top-1/2 size-4 -translate-y-1/2"
                /><span class="sr-only">Search catalog</span><Input
                  class="ps-9"
                  bind:value={query}
                  placeholder="Search catalog…"
                /></label
              ><Button type="submit" variant="secondary">Search</Button>
            </form>
          </div>
          {#if mediaMode === 'shows' && selectedSeries}<div class="grid gap-3 md:grid-cols-2">
              <Field.Field
                ><Field.Label>Season</Field.Label><Select.Root
                  type="single"
                  value={selectedSeason?.id ?? ''}
                  onValueChange={(value) => value && chooseSeason(value)}
                  ><Select.Trigger class="w-full"
                    >{selectedSeason?.name ?? 'Choose season'}</Select.Trigger
                  ><Select.Content
                    >{#each seasons as season}<Select.Item value={season.id}
                        >{season.name}</Select.Item
                      >{/each}</Select.Content
                  ></Select.Root
                ></Field.Field
              >
            </div>{/if}
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {#each selectedSeason ? episodes : results as item}<Card.Root
                class={selected?.id === item.id || selectedSeries?.id === item.id
                  ? 'ring-ring ring-2'
                  : ''}
                ><Card.Header
                  ><Card.Title class="line-clamp-1">{item.name}</Card.Title><Card.Description
                    >{item.productionYear ?? item.kind}</Card.Description
                  ></Card.Header
                ><Card.Footer
                  ><Button
                    class="w-full"
                    variant="outline"
                    disabled={searching}
                    onclick={() =>
                      mediaMode === 'shows' && !selectedSeason ? chooseSeries(item) : choose(item)}
                    >{mediaMode === 'shows' && !selectedSeason
                      ? 'Choose series'
                      : 'Select source'}</Button
                  ></Card.Footer
                ></Card.Root
              >{/each}
          </div>
        </div>
      {:else if currentStep === 2}
        <div class="space-y-5">
          <div>
            <h2 class="text-xl font-semibold">Tracks</h2>
            <p class="text-muted-foreground text-sm">
              Choose the source audio and subtitle tracks.
            </p>
          </div>
          <Card.Root
            ><Card.Header><Card.Title>{selected?.name}</Card.Title></Card.Header><Card.Content
              ><Field.Group
                ><Field.Field
                  ><Field.Label>Audio track</Field.Label><Select.Root
                    type="single"
                    bind:value={audioTrackId}
                    ><Select.Trigger class="w-full"
                      >{selected?.audioTracks?.find((track) => track.id === audioTrackId)?.title ??
                        'Default audio'}</Select.Trigger
                    ><Select.Content
                      >{#each selected?.audioTracks ?? [] as track}<Select.Item value={track.id}
                          >{track.title || track.language || track.id}</Select.Item
                        >{/each}</Select.Content
                    ></Select.Root
                  ></Field.Field
                ><Field.Field
                  ><Field.Label>Subtitles</Field.Label><Select.Root
                    type="single"
                    bind:value={subtitleTrackId}
                    ><Select.Trigger class="w-full"
                      >{subtitleTrackId === 'none'
                        ? 'None'
                        : (selected?.subtitleTracks?.find((track) => track.id === subtitleTrackId)
                            ?.title ?? 'Selected subtitle')}</Select.Trigger
                    ><Select.Content
                      ><Select.Item value="none">None</Select.Item
                      >{#each selected?.subtitleTracks ?? [] as track}<Select.Item value={track.id}
                          >{track.title || track.language || track.id}</Select.Item
                        >{/each}</Select.Content
                    ></Select.Root
                  ></Field.Field
                ></Field.Group
              ></Card.Content
            ></Card.Root
          >
        </div>
      {:else if currentStep === 3}
        <div class="space-y-5">
          <div>
            <h2 class="text-xl font-semibold">Output</h2>
            <p class="text-muted-foreground text-sm">
              Select a validated profile and placement policy.
            </p>
          </div>
          <Card.Root
            ><Card.Header><Card.Title>Playback profile</Card.Title></Card.Header><Card.Content
              ><Field.Group
                ><Field.Field
                  ><Field.Label>Profile revision</Field.Label><Select.Root
                    type="single"
                    value={profileKey}
                    onValueChange={(value) => selectProfile(value ?? '')}
                    ><Select.Trigger class="w-full"
                      >{currentProfile?.name ?? 'Choose profile'}</Select.Trigger
                    ><Select.Content
                      >{#each profiles as profile}<Select.Item
                          value={`${profile.profileId}:${profile.revision}`}
                          >{profile.name} · r{profile.revision}</Select.Item
                        >{/each}</Select.Content
                    ></Select.Root
                  ></Field.Field
                ><Field.Field
                  ><Field.Label>Platform mode</Field.Label><Select.Root
                    type="single"
                    bind:value={platformMode}
                    ><Select.Trigger class="w-full">{platformMode}</Select.Trigger><Select.Content
                      >{#each ['universal', 'pc', 'quest', 'dual'] as mode}<Select.Item value={mode}
                          >{mode}</Select.Item
                        >{/each}</Select.Content
                    ></Select.Root
                  ></Field.Field
                ></Field.Group
              ></Card.Content
            ></Card.Root
          ><Card.Root
            ><Card.Header><Card.Title>Placement</Card.Title></Card.Header><Card.Content
              ><Field.Group
                ><Field.Field
                  ><Field.Label>Policy</Field.Label><ToggleGroup.Root
                    type="single"
                    value={placementPolicy}
                    onValueChange={(value) => {
                      if (value === 'local' || value === 'hosted' || value === 'auto')
                        placementPolicy = value;
                    }}
                    ><ToggleGroup.Item value="auto">Automatic</ToggleGroup.Item><ToggleGroup.Item
                      value="hosted">Hosted</ToggleGroup.Item
                    ><ToggleGroup.Item value="local">Local</ToggleGroup.Item></ToggleGroup.Root
                  ></Field.Field
                >{#if placementPolicy !== 'local'}<div class="grid gap-3 sm:grid-cols-2">
                    <Field.Field
                      ><Field.Label>Preferred region</Field.Label><Select.Root
                        type="single"
                        value={preferredRegion || '__any__'}
                        onValueChange={(value) =>
                          (preferredRegion = value === '__any__' ? '' : (value ?? ''))}
                        ><Select.Trigger class="w-full"
                          >{preferredRegion || 'Any region'}</Select.Trigger
                        ><Select.Content
                          ><Select.Item value="__any__">Any region</Select.Item
                          >{#each regions as region}<Select.Item value={region}
                              >{region}</Select.Item
                            >{/each}</Select.Content
                        ></Select.Root
                      ></Field.Field
                    ><Field.Field
                      ><Field.Label>Preferred node</Field.Label><Select.Root
                        type="single"
                        value={preferredNodeId || '__scheduler__'}
                        onValueChange={(value) => {
                          preferredNodeId = value === '__scheduler__' ? '' : (value ?? '');
                          placementLocked = Boolean(preferredNodeId);
                        }}
                        ><Select.Trigger class="w-full"
                          >{eligibleNodes.find((node) => node.id === preferredNodeId)?.name ??
                            'Scheduler choice'}</Select.Trigger
                        ><Select.Content
                          ><Select.Item value="__scheduler__">Scheduler choice</Select.Item
                          >{#each eligibleNodes.filter((node) => !preferredRegion || node.region === preferredRegion) as node}<Select.Item
                              value={node.id}>{node.name} · {node.region}</Select.Item
                            >{/each}</Select.Content
                        ></Select.Root
                      ></Field.Field
                    >
                  </div>{/if}</Field.Group
              >{#if placementError}<Alert.Root variant="destructive"
                  ><Alert.Title>Placement unavailable</Alert.Title><Alert.Description
                    >{placementError}</Alert.Description
                  ></Alert.Root
                >{:else}<Alert.Root
                  ><Alert.Title
                    >{placementLoading
                      ? 'Checking placement…'
                      : (placementPreview?.node?.name ?? 'No eligible worker')}</Alert.Title
                  ><Alert.Description
                    >{placementPreview?.reason?.replaceAll('-', ' ') ??
                      'VRRelay is evaluating eligible capacity.'}</Alert.Description
                  ></Alert.Root
                >{/if}</Card.Content
            ></Card.Root
          >
        </div>
      {:else}
        <div class="space-y-5">
          <div>
            <h2 class="text-xl font-semibold">Review</h2>
            <p class="text-muted-foreground text-sm">
              Confirm the source and output before creating the relay.
            </p>
          </div>
          <Card.Root
            ><Card.Header><Card.Title>Relay summary</Card.Title></Card.Header><Card.Content
              >{@render Summary()}</Card.Content
            ></Card.Root
          ><Card.Root
            ><Card.Header><Card.Title>Session behavior</Card.Title></Card.Header><Card.Content
              class="space-y-3"
              ><label
                class="flex items-center justify-between rounded-lg border p-3"
                for="pin-relay"
                ><span>Keep this relay pinned</span><Switch
                  id="pin-relay"
                  bind:checked={pinned}
                /></label
              ><label
                class="flex items-center justify-between rounded-lg border p-3"
                for="report-activity"
                ><span>Report Jellyfin activity</span><Switch
                  id="report-activity"
                  bind:checked={reportActivity}
                /></label
              ></Card.Content
            ></Card.Root
          >
        </div>
      {/if}
      <div class="flex justify-between border-t pt-4">
        <Button
          variant="outline"
          disabled={currentStep === 1 || creating}
          onclick={() => (currentStep -= 1)}>Back</Button
        >{#if currentStep < 4}<Button disabled={!canContinue()} onclick={() => (currentStep += 1)}
            >Continue</Button
          >{:else}<Button
            disabled={creating || !selected || !currentProfile || !placementReady}
            onclick={createRelay}>{creating ? 'Creating…' : 'Create relay'}</Button
          >{/if}
      </div>
    </main>
    <aside class="hidden border-l p-6 xl:block">
      <h2 class="font-semibold">Summary</h2>
      <div class="mt-4">{@render Summary()}</div>
    </aside>
  </div>
</div>

<Sheet.Root bind:open={summaryOpen}
  ><Sheet.Content side="right"
    ><Sheet.Header
      ><Sheet.Title>Relay summary</Sheet.Title><Sheet.Description
        >Current source, profile and placement.</Sheet.Description
      ></Sheet.Header
    >
    <div class="p-4">{@render Summary()}</div></Sheet.Content
  ></Sheet.Root
>
