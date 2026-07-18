<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '#lib/api';
  import { Toaster } from '#lib/new-ui/components/ui/sonner';
  import { TooltipProvider } from '#lib/new-ui/components/ui/tooltip';
  import { applyRouteTheme, readThemePreference } from '#lib/new-ui/state.svelte';

  let { children } = $props();
  let ready = $state(false);

  afterNavigate(({ to }) => to && applyRouteTheme(to.url.pathname));

  onMount(() => {
    applyRouteTheme(page.url.pathname);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const syncSystemTheme = () => {
      if (readThemePreference() === 'system') applyRouteTheme(location.pathname);
    };
    media.addEventListener('change', syncSystemTheme);
    void (async () => {
      try {
        const setup = await api.setupStatus();
        const currentPath = location.pathname;
        const setupPath = '/dashboard/setup';
        const loginPath = '/dashboard/login';
        if (!setup.configured && currentPath !== setupPath) await goto(setupPath);
        if (setup.configured && currentPath === setupPath) await goto(loginPath);
        if (setup.configured && currentPath === '/') {
          const portal = await api.portalStatus();
          await goto(portal.configured ? '/portal' : '/dashboard');
        }
      } catch {
        // The route itself will present a useful connection error.
      } finally {
        ready = true;
      }
    })();
    return () => media.removeEventListener('change', syncSystemTheme);
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
  <Toaster theme="system" position="bottom-right" expand />
</TooltipProvider>
