<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import NewShell from '$lib/new-ui/components/NewShell.svelte';

  let { children }: { children: Snippet } = $props();
  let standalone = $derived(
    page.url.pathname.endsWith('/login') || page.url.pathname.endsWith('/setup')
  );
</script>

{#if standalone}
  {@render children()}
{:else}
  <NewShell>{@render children()}</NewShell>
{/if}
