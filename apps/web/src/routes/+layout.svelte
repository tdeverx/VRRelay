<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Toaster } from 'svelte-sonner';
  import { TooltipProvider } from '$lib/components/ui/tooltip';
  import { api } from '$lib/api';

  let { children } = $props();
  let ready = $state(false);

  onMount(async () => {
    try {
      const setup = await api.setupStatus();
      if (!setup.configured && page.url.pathname !== '/setup') await goto('/setup');
      if (setup.configured && page.url.pathname === '/setup') await goto('/login');
    } catch {
      // The route itself will present a useful connection error.
    } finally {
      ready = true;
    }
  });
</script>

<svelte:head>
  <title>VRRelay</title>
  <meta
    name="description"
    content="Self-hosted Jellyfin VOD and OBS live relay for VRChat video players."
  />
</svelte:head>

<TooltipProvider>
  {#if ready}{@render children()}{/if}
  <Toaster richColors theme="dark" position="bottom-right" expand />
</TooltipProvider>
