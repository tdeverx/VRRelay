<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Copy, Film, Link2, LogOut, Search, Trash2, Tv } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { MediaItem, ProfileRevision, RelaySession } from '@vrrelay/domain';
  import { isAuthenticatedError, portalApi } from '#lib/api';
  import PortalArtwork from '#lib/new-ui/components/PortalArtwork.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Dialog from '#lib/new-ui/components/ui/dialog';
  import * as Empty from '#lib/new-ui/components/ui/empty';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as Select from '#lib/new-ui/components/ui/select';
  import { Separator } from '#lib/new-ui/components/ui/separator';
  import { Skeleton } from '#lib/new-ui/components/ui/skeleton';

  let username = $state('');
  let search = $state('');
  let items = $state<MediaItem[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let profileId = $state('');
  let sessions = $state<RelaySession[]>([]);
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
  let selectedSeason = $derived(seasons.find((season) => season.id === selectedSeasonId) ?? null);

  onMount(load);

  async function load() {
    try {
      const [user, profileResult, sessionResult] = await Promise.all([
        portalApi.me(),
        portalApi.profiles(),
        portalApi.sessions()
      ]);
      username = user.username;
      profiles = profileResult.items;
      profileId = profileResult.defaultProfileId;
      sessions = sessionResult.items;
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto('/portal/login');
      toast.error(reason instanceof Error ? reason.message : 'Could not load the portal.');
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
      items = (await portalApi.catalog({ search: query, kinds: ['Movie', 'Series'], limit: 48 }))
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
      seasons = (await portalApi.catalog({ parentId: show.id, kinds: ['Season'], limit: 100 }))
        .items;
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
      episodes = (await portalApi.catalog({ parentId: seasonId, kinds: ['Episode'], limit: 200 }))
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
      const session = await portalApi.createSession({
        source: { providerId: item.providerId, itemId: item.id },
        ...(profileId ? { profileId } : {})
      });
      sessions = [session, ...sessions];
      selectionOpen = false;
      await copy(session.outputUrls.primary);
      toast.success('Relay link created and copied.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not create a relay link.');
    } finally {
      creatingItemId = '';
    }
  }

  async function deleteLink(sessionId: string) {
    try {
      await portalApi.deleteSession(sessionId);
      sessions = sessions.filter((session) => session.id !== sessionId);
      toast.success('Relay link removed.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not remove the relay link.');
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
  }

  async function logout() {
    await portalApi.logout();
    await goto('/portal/login');
  }
</script>

<div class="min-h-svh">
  <header class="border-b">
    <div class="mx-auto flex max-w-7xl items-center gap-3 p-4 md:px-6">
      <Film class="size-5" />
      <strong class="flex-1">VRRelay</strong>
      <span class="text-muted-foreground hidden text-sm sm:inline">{username}</span>
      <Button variant="ghost" size="icon" aria-label="Sign out" onclick={logout}><LogOut /></Button>
    </div>
  </header>

  <main class="mx-auto max-w-7xl space-y-8 p-4 md:p-6">
    <section class="space-y-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Your relay links</h1>
        <p class="text-muted-foreground text-sm">
          Anyone with a link can play it until you remove it.
        </p>
      </div>
      {#if loading}
        <div class="grid gap-3 md:grid-cols-2">
          {#each Array(2) as _}<Skeleton class="h-36" />{/each}
        </div>
      {:else if sessions.length === 0}
        <Empty.Root>
          <Empty.Header
            ><Empty.Media variant="icon"><Link2 /></Empty.Media><Empty.Title
              >No links yet</Empty.Title
            ></Empty.Header
          >
          <Empty.Content
            ><Empty.Description>Search below to create your first link.</Empty.Description
            ></Empty.Content
          >
        </Empty.Root>
      {:else}
        <div class="grid gap-3 md:grid-cols-2">
          {#each sessions as session}
            <Card.Root>
              <Card.Header
                ><Card.Title>{session.name}</Card.Title><Card.Description
                  >{session.state}</Card.Description
                ></Card.Header
              >
              <Card.Content
                ><p class="text-muted-foreground truncate text-sm">
                  {session.outputUrls.primary}
                </p></Card.Content
              >
              <Card.Footer class="gap-2">
                <Button
                  variant="outline"
                  class="flex-1"
                  onclick={() => copy(session.outputUrls.primary)}><Copy />Copy</Button
                >
                <Button
                  variant="destructive"
                  size="icon"
                  aria-label={`Remove ${session.name}`}
                  onclick={() => deleteLink(session.id)}><Trash2 /></Button
                >
              </Card.Footer>
            </Card.Root>
          {/each}
        </div>
      {/if}
    </section>

    <Separator />

    <section class="space-y-4">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Choose something to relay</h2>
        <p class="text-muted-foreground text-sm">
          Search for a movie or show available to your Jellyfin account.
        </p>
      </div>
      <form class="flex flex-col gap-3 sm:flex-row" onsubmit={runSearch}>
        <Field.Field class="flex-1">
          <Field.Label class="sr-only" for="portal-search">Search movies and shows</Field.Label>
          <Input id="portal-search" bind:value={search} placeholder="Search movies and shows" />
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
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {#each Array(8) as _}<Skeleton class="aspect-[2/3]" />{/each}
        </div>
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
            <Card.Root class="overflow-hidden">
              <PortalArtwork {item} />
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
  </main>
</div>

<Dialog.Root bind:open={selectionOpen}>
  <Dialog.Content class="max-h-[90svh] overflow-y-auto sm:max-w-4xl">
    <Dialog.Header>
      <Dialog.Title>{selectedShow?.name ?? 'Choose an episode'}</Dialog.Title>
      <Dialog.Description>Select a season, then create a link for an episode.</Dialog.Description>
    </Dialog.Header>

    {#if loadingSeasons}
      <div class="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <Skeleton class="aspect-[2/3]" />
        <div class="space-y-3">
          {#each Array(4) as _}<Skeleton class="h-24" />{/each}
        </div>
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
        <div class="grid gap-4 sm:grid-cols-[12rem_1fr]">
          <div class="space-y-2">
            <PortalArtwork item={selectedSeason} />
            <p class="text-sm font-medium">{selectedSeason.name}</p>
          </div>
          {#if loadingEpisodes}
            <div class="space-y-3">
              {#each Array(4) as _}<Skeleton class="h-24" />{/each}
            </div>
          {:else if episodes.length === 0}
            <Empty.Root>
              <Empty.Header><Empty.Title>No episodes found</Empty.Title></Empty.Header>
            </Empty.Root>
          {:else}
            <div class="grid content-start gap-3">
              {#each episodes as episode}
                <Card.Root class="overflow-hidden sm:grid sm:grid-cols-[10rem_1fr]">
                  <PortalArtwork item={episode} shape="episode" />
                  <div>
                    <Card.Header>
                      <Card.Title class="text-base">
                        {episode.indexNumber ? `${episode.indexNumber}. ` : ''}{episode.name}
                      </Card.Title>
                      <Card.Description
                        >{episode.seasonName ?? selectedSeason.name}</Card.Description
                      >
                    </Card.Header>
                    <Card.Footer>
                      <Button
                        class="w-full"
                        disabled={creatingItemId === episode.id}
                        onclick={() => createLink(episode)}
                      >
                        <Link2 />{creatingItemId === episode.id ? 'Creating…' : 'Create link'}
                      </Button>
                    </Card.Footer>
                  </div>
                </Card.Root>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
