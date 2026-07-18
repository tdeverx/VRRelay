<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import AdminShell from '#lib/new-ui/components/AdminShell.svelte';

  let { children }: { children: Snippet } = $props();
  let standalone = $derived(
    page.url.pathname.endsWith('/login') || page.url.pathname.endsWith('/setup')
  );
</script>

{#if standalone}
  {@render children()}
{:else}
  <AdminShell>{@render children()}</AdminShell>
{/if}
