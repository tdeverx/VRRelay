<script lang="ts">
  import { Film } from '@lucide/svelte';
  import type { MediaItem } from '@vrrelay/domain';

  let {
    item,
    shape = 'poster',
    class: className = ''
  }: { item: MediaItem; shape?: 'poster' | 'episode'; class?: string } = $props();
  let failed = $state(false);
</script>

<div
  class={[
    'bg-muted grid overflow-hidden',
    shape === 'poster' ? 'aspect-[2/3]' : 'aspect-video',
    className
  ]}
>
  {#if item.imageUrl && !failed}
    <img
      class="size-full object-cover"
      src={item.imageUrl}
      alt={shape === 'poster' ? `${item.name} poster` : `${item.name} episode image`}
      loading="lazy"
      onerror={() => (failed = true)}
    />
  {:else}
    <Film class="text-muted-foreground m-auto size-8" aria-hidden="true" />
  {/if}
</div>
