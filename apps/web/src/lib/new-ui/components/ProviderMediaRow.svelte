<script lang="ts">
  import { Link2, Tv } from '@lucide/svelte';
  import type { MediaItem } from '@vrrelay/domain';
  import ProviderArtwork from '#lib/new-ui/components/ProviderArtwork.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import { Progress } from '#lib/new-ui/components/ui/progress';
  import { Skeleton } from '#lib/new-ui/components/ui/skeleton';

  let {
    id,
    title,
    description,
    items,
    loading = false,
    creatingItemId = '',
    onChoose
  }: {
    id: string;
    title: string;
    description: string;
    items: MediaItem[];
    loading?: boolean;
    creatingItemId?: string;
    onChoose: (item: MediaItem) => void | Promise<void>;
  } = $props();

  function itemDescription(item: MediaItem): string {
    if (item.kind === 'Episode') {
      const episode = [
        item.parentIndexNumber !== undefined ? `S${item.parentIndexNumber}` : '',
        item.indexNumber !== undefined ? `E${item.indexNumber}` : ''
      ].join('');
      return [item.seriesName, episode].filter(Boolean).join(' · ');
    }
    return [item.productionYear, item.kind === 'Series' ? 'Show' : item.kind]
      .filter(Boolean)
      .join(' · ');
  }

  function progressLabel(item: MediaItem): string {
    const seconds = Math.max(0, Math.floor(item.playbackPositionSeconds ?? 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m watched` : `${minutes}m watched`;
  }
</script>

{#if loading || items.length > 0}
  <section class="space-y-3" aria-labelledby={id} data-testid={`catalog-row-${id}`}>
    <div>
      <h2 {id} class="text-lg font-semibold tracking-tight">{title}</h2>
      <p class="text-muted-foreground text-sm">{description}</p>
    </div>
    <div class="-mx-4 overflow-x-auto px-4 pb-2 md:-mx-6 md:px-6">
      <div class="flex min-w-max gap-4">
        {#if loading}
          {#each Array(5) as _}
            <div class="w-64 shrink-0 space-y-3">
              <Skeleton class="aspect-video w-full" />
              <Skeleton class="h-4 w-4/5" />
              <Skeleton class="h-9 w-full" />
            </div>
          {/each}
        {:else}
          {#each items as item}
            <Card.Root class="w-64 shrink-0 overflow-hidden" style="padding-top: 0">
              <ProviderArtwork {item} shape="episode" />
              <Card.Header class="gap-1">
                <Card.Title class="line-clamp-1 text-base">{item.name}</Card.Title>
                <Card.Description class="line-clamp-1">{itemDescription(item)}</Card.Description>
              </Card.Header>
              {#if item.playedPercentage !== undefined}
                <Card.Content class="space-y-1.5">
                  <Progress
                    class="h-1.5"
                    value={Math.min(100, Math.max(0, item.playedPercentage))}
                    aria-label={`${Math.round(item.playedPercentage)} percent watched`}
                  />
                  <span class="text-muted-foreground text-xs">{progressLabel(item)}</span>
                </Card.Content>
              {/if}
              <Card.Footer>
                <Button
                  class="w-full"
                  variant="outline"
                  disabled={creatingItemId === item.id}
                  onclick={() => onChoose(item)}
                >
                  {#if item.kind === 'Series'}<Tv />{:else}<Link2 />{/if}
                  {creatingItemId === item.id
                    ? 'Creating…'
                    : item.kind === 'Series'
                      ? 'Choose episode'
                      : 'Create link'}
                </Button>
              </Card.Footer>
            </Card.Root>
          {/each}
        {/if}
      </div>
    </div>
  </section>
{/if}
