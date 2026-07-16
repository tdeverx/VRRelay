<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Copy, Film, Link2, LogOut, Search, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { MediaItem, ProfileRevision, RelaySession } from '@vrrelay/domain';
  import { isAuthenticatedError, portalApi } from '$lib/api';
  import { Button } from '$lib/new-ui/components/ui/button';
  import * as Card from '$lib/new-ui/components/ui/card';
  import * as Empty from '$lib/new-ui/components/ui/empty';
  import * as Field from '$lib/new-ui/components/ui/field';
  import { Input } from '$lib/new-ui/components/ui/input';
  import * as Select from '$lib/new-ui/components/ui/select';
  import { Separator } from '$lib/new-ui/components/ui/separator';
  import { Skeleton } from '$lib/new-ui/components/ui/skeleton';

  let username = $state('');
  let search = $state('');
  let items = $state<MediaItem[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let profileId = $state('');
  let sessions = $state<RelaySession[]>([]);
  let loading = $state(true);
  let searching = $state(false);
  let creatingItemId = $state('');

  onMount(load);

  async function load() {
    try {
      const [user, catalog, profileResult, sessionResult] = await Promise.all([
        portalApi.me(),
        portalApi.catalog({ kinds: ['Movie', 'Episode'], limit: 24 }),
        portalApi.profiles(),
        portalApi.sessions()
      ]);
      username = user.username;
      items = catalog.items;
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
    searching = true;
    try {
      items = (
        await portalApi.catalog({
          search: search || undefined,
          kinds: ['Movie', 'Episode'],
          limit: 48
        })
      ).items;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Search failed.');
    } finally {
      searching = false;
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
        <h1 class="text-2xl font-semibold tracking-tight">Choose something to relay</h1>
        <p class="text-muted-foreground text-sm">
          Search the media available to your Jellyfin account and create a shareable playback link.
        </p>
      </div>
      <form class="flex flex-col gap-3 sm:flex-row" onsubmit={runSearch}>
        <Field.Field class="flex-1">
          <Field.Label class="sr-only" for="portal-search">Search your library</Field.Label>
          <Input id="portal-search" bind:value={search} placeholder="Search your library" />
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
        <Button type="submit" disabled={searching}
          ><Search />{searching ? 'Searching…' : 'Search'}</Button
        >
      </form>

      {#if loading}
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {#each Array(8) as _}<Skeleton class="h-40" />{/each}
        </div>
      {:else if items.length === 0}
        <Empty.Root>
          <Empty.Header
            ><Empty.Media variant="icon"><Search /></Empty.Media><Empty.Title
              >No media found</Empty.Title
            ></Empty.Header
          >
          <Empty.Content
            ><Empty.Description>Try a different title or clear the search.</Empty.Description
            ></Empty.Content
          >
        </Empty.Root>
      {:else}
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {#each items as item}
            <Card.Root>
              <Card.Header>
                <Card.Title>{item.name}</Card.Title>
                <Card.Description>
                  {[item.productionYear, item.seriesName ?? item.kind].filter(Boolean).join(' · ')}
                </Card.Description>
              </Card.Header>
              <Card.Content class="text-muted-foreground line-clamp-3 text-sm">
                {item.overview ?? 'Ready to create a relay link.'}
              </Card.Content>
              <Card.Footer>
                <Button
                  class="w-full"
                  disabled={creatingItemId === item.id}
                  onclick={() => createLink(item)}
                >
                  <Link2 />{creatingItemId === item.id ? 'Creating…' : 'Create link'}
                </Button>
              </Card.Footer>
            </Card.Root>
          {/each}
        </div>
      {/if}
    </section>

    <Separator />

    <section class="space-y-4">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Your relay links</h2>
        <p class="text-muted-foreground text-sm">
          Anyone with a link can play it until you remove it.
        </p>
      </div>
      {#if sessions.length === 0}
        <Empty.Root>
          <Empty.Header
            ><Empty.Media variant="icon"><Link2 /></Empty.Media><Empty.Title
              >No links yet</Empty.Title
            ></Empty.Header
          >
          <Empty.Content
            ><Empty.Description>Select media above to create your first link.</Empty.Description
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
  </main>
</div>
