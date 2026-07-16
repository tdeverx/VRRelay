<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Film, Plus, Search } from '@lucide/svelte';
  import type { MediaItem, PublicProviderConnection } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '$lib/api';
  import { adminRoute } from '$lib/new-ui/state.svelte';
  import PageHeader from '$lib/new-ui/components/PageHeader.svelte';
  import LoadState from '$lib/new-ui/components/LoadState.svelte';
  import { Button } from '$lib/new-ui/components/ui/button';
  import * as Card from '$lib/new-ui/components/ui/card';
  import { Input } from '$lib/new-ui/components/ui/input';
  import * as Select from '$lib/new-ui/components/ui/select';

  let providers = $state<PublicProviderConnection[]>([]);
  let items = $state<MediaItem[]>([]);
  let providerId = $state('');
  let search = $state('');
  let loading = $state(true);
  let error = $state('');

  onMount(load);

  async function load() {
    try {
      providers = (await api.providers()).items.filter(
        (provider) => provider.authMode !== 'delegated'
      );
      providerId = providers[0]?.id ?? '';
      if (providerId) await browse();
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(adminRoute(page.url.pathname, '/login'));
      error = reason instanceof Error ? reason.message : 'Could not load library.';
    } finally {
      loading = false;
    }
  }

  async function browse() {
    if (!providerId) return;
    loading = true;
    error = '';
    try {
      items = (await api.catalog(providerId, { search: search || undefined, limit: 60 })).items;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Search failed.';
    } finally {
      loading = false;
    }
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Library"
    description="Browse provider-neutral media and start a just-in-time relay."
  />
  <div class="flex flex-col gap-3 md:flex-row">
    <Select.Root type="single" bind:value={providerId} onValueChange={() => void browse()}>
      <Select.Trigger class="w-full md:w-56">
        {providers.find((provider) => provider.id === providerId)?.name ?? 'Media provider'}
      </Select.Trigger>
      <Select.Content>
        {#each providers as provider}<Select.Item value={provider.id}>{provider.name}</Select.Item
          >{/each}
      </Select.Content>
    </Select.Root>
    <form
      class="flex flex-1 gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        void browse();
      }}
    >
      <label class="relative flex-1">
        <Search
          class="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
        />
        <span class="sr-only">Search library</span>
        <Input class="ps-9" bind:value={search} placeholder="Search your library…" />
      </label>
      <Button type="submit" variant="secondary">Search</Button>
    </form>
  </div>

  <LoadState {loading} {error} empty={!loading && !error && items.length === 0} label="media" />
  {#if !loading && !error && items.length}
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {#each items as item (item.id)}
        <Card.Root class="overflow-hidden">
          <div class="bg-muted grid aspect-video place-items-center overflow-hidden">
            {#if item.imageUrl}<img
                class="size-full object-cover"
                src={item.imageUrl}
                alt=""
              />{:else}<Film class="text-muted-foreground size-8" />{/if}
          </div>
          <Card.Header>
            <Card.Title class="line-clamp-1">{item.name}</Card.Title>
            <Card.Description
              >{[item.productionYear, item.kind, item.videoCodec?.toUpperCase()]
                .filter(Boolean)
                .join(' · ')}</Card.Description
            >
          </Card.Header>
          <Card.Footer
            ><Button class="w-full" size="sm" href={adminRoute(page.url.pathname, '/relay/new')}
              ><Plus data-icon="inline-start" />Relay</Button
            ></Card.Footer
          >
        </Card.Root>
      {/each}
    </div>
  {/if}
</div>
