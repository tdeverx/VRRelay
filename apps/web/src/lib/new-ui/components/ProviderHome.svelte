<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Link2, Search, Tv } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { MediaItem, ProfileRevision } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import ProviderArtwork from '#lib/new-ui/components/ProviderArtwork.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Dialog from '#lib/new-ui/components/ui/dialog';
  import * as Empty from '#lib/new-ui/components/ui/empty';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as Select from '#lib/new-ui/components/ui/select';
  import { Skeleton } from '#lib/new-ui/components/ui/skeleton';

  let username = $state('');
  let search = $state('');
  let items = $state<MediaItem[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let profileId = $state('');
  let loading = $state(true);
  let searching = $state(false);
  let hasSearched = $state(false);
  let creatingItemId = $state('');
  let selectionOpen = $state(false);
  let selectedShow = $state<MediaItem | null>(null);
  let seasons = $state<MediaItem[]>([]);
  let selectedSeasonId = $state('');
  let episodes = $state<MediaItem[]>([]);
  let loadingSeasons = $state(false);
  let loadingEpisodes = $state(false);
  let recovery = $state(false);
  let selectedSeason = $derived(seasons.find((season) => season.id === selectedSeasonId) ?? null);

  onMount(load);

  async function load() {
    try {
      const user = await api.me();
      username = user.displayName;
      recovery = user.authMethod === 'recovery';
      if (recovery) return;
      const profileResult = await api.catalogProfiles();
      profiles = profileResult.items;
      profileId = profileResult.defaultProfileId ?? profiles[0]?.profileId ?? '';
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto('/dashboard/login');
      toast.error(reason instanceof Error ? reason.message : 'Could not load your home page.');
    } finally {
      loading = false;
    }
  }

  async function runSearch(event?: SubmitEvent) {
    event?.preventDefault();
    const query = search.trim();
    if (!query) {
      items = [];
      hasSearched = false;
      return;
    }
    searching = true;
    hasSearched = true;
    selectedShow = null;
    seasons = [];
    episodes = [];
    try {
      items = (await api.userCatalog({ search: query, kinds: ['Movie', 'Series'], limit: 48 }))
        .items;
    } catch (reason) {
      items = [];
      toast.error(reason instanceof Error ? reason.message : 'Search failed.');
    } finally {
      searching = false;
    }
  }

  async function chooseShow(show: MediaItem) {
    selectedShow = show;
    seasons = [];
    selectedSeasonId = '';
    episodes = [];
    selectionOpen = true;
    loadingSeasons = true;
    try {
      seasons = (await api.userCatalog({ parentId: show.id, kinds: ['Season'], limit: 100 })).items;
      if (seasons[0]) await chooseSeason(seasons[0].id);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load seasons.');
    } finally {
      loadingSeasons = false;
    }
  }

  async function chooseSeason(seasonId: string) {
    selectedSeasonId = seasonId;
    episodes = [];
    if (!seasonId) return;
    loadingEpisodes = true;
    try {
      episodes = (await api.userCatalog({ parentId: seasonId, kinds: ['Episode'], limit: 200 }))
        .items;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load episodes.');
    } finally {
      loadingEpisodes = false;
    }
  }

  async function createLink(item: MediaItem) {
    creatingItemId = item.id;
    try {
      const profile = profiles.find((candidate) => candidate.profileId === profileId);
      if (!profile) throw new Error('Choose an available relay profile.');
      const session = await api.createVodSession({
        source: { providerId: item.providerId, itemId: item.id },
        profileId: profile.profileId,
        profileRevision: profile.revision,
        platformMode: profile.platform,
        pinned: false,
        reportActivity: true,
        placementPolicy: 'local'
      });
      selectionOpen = false;
      await copy(session.outputUrls.primary);
      toast.success('Relay link created and copied.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not create a relay link.');
    } finally {
      creatingItemId = '';
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
  }
</script>

<div class="mx-auto max-w-7xl space-y-8 p-4 md:p-6">
  {#if loading}
    <section class="space-y-5">
      <div class="space-y-2">
        <Skeleton class="h-8 w-72 max-w-full" />
        <Skeleton class="h-4 w-96 max-w-full" />
      </div>
      <div class="flex flex-col gap-3 sm:flex-row">
        <Skeleton class="h-9 flex-1" />
        <Skeleton class="h-9 w-full sm:w-28" />
      </div>
      <LoadState loading label="Jellyfin discovery" variant="media" />
    </section>
  {:else if recovery}
    <Card.Root class="max-w-2xl">
      <Card.Header>
        <h1 class="text-lg leading-none font-semibold">Recovery administration</h1>
        <Card.Description>
          This account can configure VRRelay, but it has no personal Jellyfin catalog. Sign out and
          use a Jellyfin account to create personal relay links.
        </Card.Description>
      </Card.Header>
      <Card.Footer class="gap-2">
        <Button href="/dashboard/settings/connections">Open settings</Button>
        <Button href="/dashboard/system/diagnostics" variant="outline">View system health</Button>
      </Card.Footer>
    </Card.Root>
  {:else}
    <section class="space-y-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Choose something to relay</h1>
        <p class="text-muted-foreground text-sm">
          Search for a movie or show available to your Jellyfin account.
        </p>
      </div>
      <form class="flex flex-col gap-3 sm:flex-row" onsubmit={runSearch}>
        <Field.Field class="flex-1">
          <Field.Label class="sr-only" for="catalog-search">Search movies and shows</Field.Label>
          <Input id="catalog-search" bind:value={search} placeholder="Search movies and shows" />
        </Field.Field>
        {#if profiles.length > 1}
          <Select.Root type="single" bind:value={profileId}>
            <Select.Trigger class="w-full sm:w-56">
              {profiles.find((profile) => profile.profileId === profileId)?.name ?? 'Profile'}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                {#each profiles as profile}
                  <Select.Item value={profile.profileId}>{profile.name}</Select.Item>
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
        {/if}
        <Button type="submit" disabled={searching || !search.trim()}
          ><Search />{searching ? 'Searching…' : 'Search'}</Button
        >
      </form>

      {#if searching}
        <LoadState loading label="catalog results" variant="media" count={8} />
      {:else if hasSearched && items.length === 0}
        <Empty.Root>
          <Empty.Header
            ><Empty.Media variant="icon"><Search /></Empty.Media><Empty.Title
              >No movies or shows found</Empty.Title
            ></Empty.Header
          >
          <Empty.Content
            ><Empty.Description>Try a different title.</Empty.Description></Empty.Content
          >
        </Empty.Root>
      {:else if hasSearched}
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {#each items as item}
            <Card.Root class="overflow-hidden" style="padding-top: 0">
              <ProviderArtwork {item} />
              <Card.Header>
                <Card.Title>{item.name}</Card.Title>
                <Card.Description>
                  {[item.productionYear, item.kind === 'Series' ? 'Show' : 'Movie']
                    .filter(Boolean)
                    .join(' · ')}
                </Card.Description>
              </Card.Header>
              <Card.Content class="text-muted-foreground line-clamp-3 text-sm">
                {item.overview ??
                  (item.kind === 'Series'
                    ? 'Choose a season and episode to create a relay link.'
                    : 'Ready to create a relay link.')}
              </Card.Content>
              <Card.Footer>
                {#if item.kind === 'Series'}
                  <Button class="w-full" variant="outline" onclick={() => chooseShow(item)}>
                    <Tv />Choose episode
                  </Button>
                {:else}
                  <Button
                    class="w-full"
                    disabled={creatingItemId === item.id}
                    onclick={() => createLink(item)}
                  >
                    <Link2 />{creatingItemId === item.id ? 'Creating…' : 'Create link'}
                  </Button>
                {/if}
              </Card.Footer>
            </Card.Root>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<Dialog.Root bind:open={selectionOpen}>
  <Dialog.Content class="max-h-[90svh] overflow-y-auto sm:max-w-4xl">
    <Dialog.Header>
      <Dialog.Title>{selectedShow?.name ?? 'Choose an episode'}</Dialog.Title>
      <Dialog.Description>Select a season, then create a link for an episode.</Dialog.Description>
    </Dialog.Header>

    {#if loadingSeasons}
      <div class="space-y-3">
        <Skeleton class="h-9 w-full" />
        {#each Array(4) as _}<Skeleton class="h-44" />{/each}
      </div>
    {:else if seasons.length === 0}
      <Empty.Root>
        <Empty.Header
          ><Empty.Media variant="icon"><Tv /></Empty.Media><Empty.Title
            >No seasons found</Empty.Title
          ></Empty.Header
        >
      </Empty.Root>
    {:else}
      <Field.Field>
        <Field.Label>Season</Field.Label>
        <Select.Root
          type="single"
          value={selectedSeasonId}
          onValueChange={(value) => value && chooseSeason(value)}
        >
          <Select.Trigger class="w-full">{selectedSeason?.name ?? 'Choose season'}</Select.Trigger>
          <Select.Content>
            {#each seasons as season}<Select.Item value={season.id}>{season.name}</Select.Item
              >{/each}
          </Select.Content>
        </Select.Root>
      </Field.Field>

      {#if selectedSeason}
        {#if loadingEpisodes}
          <div class="grid gap-4 md:grid-cols-2">
            {#each Array(4) as _}<Skeleton class="h-64" />{/each}
          </div>
        {:else if episodes.length === 0}
          <Empty.Root>
            <Empty.Header><Empty.Title>No episodes found</Empty.Title></Empty.Header>
          </Empty.Root>
        {:else}
          <div class="grid content-start gap-4 md:grid-cols-2">
            {#each episodes as episode}
              <Card.Root class="overflow-hidden" style="padding-top: 0">
                <ProviderArtwork item={episode} shape="episode" />
                <Card.Header>
                  <Card.Title class="text-base">
                    {episode.indexNumber ? `${episode.indexNumber}. ` : ''}{episode.name}
                  </Card.Title>
                  <Card.Description>
                    {[episode.seasonName ?? selectedSeason.name, episode.productionYear]
                      .filter(Boolean)
                      .join(' · ')}
                  </Card.Description>
                </Card.Header>
                <Card.Content class="text-muted-foreground line-clamp-3 text-sm">
                  {episode.overview ?? 'Ready to create a relay link for this episode.'}
                </Card.Content>
                <Card.Footer>
                  <Button
                    class="w-full"
                    disabled={creatingItemId === episode.id}
                    onclick={() => createLink(episode)}
                  >
                    <Link2 />{creatingItemId === episode.id ? 'Creating…' : 'Create link'}
                  </Button>
                </Card.Footer>
              </Card.Root>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
