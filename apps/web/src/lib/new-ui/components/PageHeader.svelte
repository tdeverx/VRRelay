<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, description, actions }: { title: string; description?: string; actions?: Snippet } =
    $props();
</script>

<header class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
  <div class="space-y-1">
    <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
    {#if description}<p class="text-muted-foreground text-sm">{description}</p>{/if}
  </div>
  {#if actions}<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>{/if}
</header>
