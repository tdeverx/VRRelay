<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Film, Search, Plus } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { MediaItem, PublicProviderConnection } from '@vrrelay/domain';
  import AppShell from '$lib/components/AppShell.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Select from '$lib/components/ui/select';
  import * as Empty from '$lib/components/ui/empty';
  let providers = $state<PublicProviderConnection[]>([]),
    items = $state<MediaItem[]>([]),
    providerId = $state(''),
    search = $state(''),
    loading = $state(true);
  onMount(load);
  async function load() {
    try {
      providers = (await api.providers()).items;
      providerId = providers[0]?.id ?? '';
      if (providerId) await browse();
    } catch (e) {
      if (isAuthenticatedError(e)) return goto('/login');
      toast.error(e instanceof Error ? e.message : 'Could not load library.');
    } finally {
      loading = false;
    }
  }
  async function browse() {
    if (!providerId) return;
    loading = true;
    try {
      items = (await api.catalog(providerId, { search: search || undefined, limit: 60 })).items;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      loading = false;
    }
  }
</script>

<AppShell active="library"
  ><div class="page">
    <PageHeader
      title="Library"
      description="Browse provider-neutral media and start a just-in-time relay."
    />
    <div class="toolbar">
      <Select.Root type="single" bind:value={providerId} onValueChange={() => void browse()}
        ><Select.Trigger
          >{providers.find((p) => p.id === providerId)?.name ?? 'Media provider'}</Select.Trigger
        ><Select.Content
          ><Select.Group
            >{#each providers as p}<Select.Item value={p.id} label={p.name}>{p.name}</Select.Item
              >{/each}</Select.Group
          ></Select.Content
        ></Select.Root
      >
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void browse();
        }}
      >
        <Search /><Input bind:value={search} placeholder="Search your library…" /><Button
          type="submit"
          variant="secondary">Search</Button
        >
      </form>
    </div>
    {#if !loading && items.length === 0}<Empty.Root
        ><Empty.Header
          ><Empty.Media variant="icon"><Film /></Empty.Media><Empty.Title
            >No media found</Empty.Title
          ><Empty.Description>Connect Jellyfin in Settings or change your search.</Empty.Description
          ></Empty.Header
        ></Empty.Root
      >{:else}<div class="grid">
        {#each items as item}<article>
            <div class="art">
              {#if item.imageUrl}<img src={item.imageUrl} alt="" />{:else}<Film />{/if}
            </div>
            <div>
              <h2>{item.name}</h2>
              <p>
                {[item.productionYear, item.videoCodec?.toUpperCase()]
                  .filter(Boolean)
                  .join(' · ') || item.kind}
              </p>
            </div>
            <Button size="sm" href="/relay/new"><Plus />Relay</Button>
          </article>{/each}
      </div>{/if}
  </div></AppShell
>

<style>
  .page {
    padding: 34px 38px;
  }
  .toolbar {
    display: flex;
    gap: 12px;
    margin-bottom: 22px;
  }
  .toolbar form {
    display: flex;
    position: relative;
    flex: 1;
    gap: 8px;
  }
  .toolbar form > :global(svg) {
    position: absolute;
    left: 12px;
    top: 10px;
    width: 16px;
    color: var(--muted-foreground);
  }
  .toolbar :global(input) {
    padding-left: 36px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 10px;
  }
  .grid article {
    display: grid;
    grid-template-columns: 48px 1fr auto;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    padding: 10px;
  }
  .art {
    display: grid;
    width: 48px;
    height: 64px;
    place-items: center;
    overflow: hidden;
    border-radius: 5px;
    background: var(--muted);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .art :global(svg) {
    width: 18px;
    color: var(--muted-foreground);
  }
  h2 {
    overflow: hidden;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  article p {
    margin-top: 5px;
    color: var(--muted-foreground);
    font-size: 10px;
  }
  @media (max-width: 650px) {
    .page {
      padding: 24px 16px;
    }
    .toolbar {
      flex-direction: column;
    }
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
