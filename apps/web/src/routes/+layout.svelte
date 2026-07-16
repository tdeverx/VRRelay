<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Toaster } from 'svelte-sonner';
  import { TooltipProvider } from '$lib/components/ui/tooltip';
  import { api } from '$lib/api';
  import { Toaster as NewToaster } from '$lib/new-ui/components/ui/sonner';
  import {
    applyRouteTheme,
    isNewPath,
    readThemePreference,
    UI_VERSION_KEY
  } from '$lib/new-ui/state.svelte';

  let { children } = $props();
  let ready = $state(false);
  let newRoute = $derived(isNewPath(page.url.pathname));

  afterNavigate(({ to }) => to && applyRouteTheme(to.url.pathname));

  onMount(() => {
    applyRouteTheme(page.url.pathname);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const syncSystemTheme = () => {
      if (isNewPath(location.pathname) && readThemePreference() === 'system') {
        applyRouteTheme(location.pathname);
      }
    };
    media.addEventListener('change', syncSystemTheme);
    void (async () => {
      try {
        const setup = await api.setupStatus();
        const currentPath = location.pathname;
        const namespace =
          currentPath === '/dashboard' || currentPath.startsWith('/dashboard/')
            ? '/dashboard'
            : currentPath === '/new' || currentPath.startsWith('/new/')
              ? '/new'
              : currentPath === '/portal' || currentPath.startsWith('/portal/')
                ? '/dashboard'
                : '';
        const setupPath = `${namespace}/setup`;
        const loginPath = `${namespace}/login`;
        if (!setup.configured && currentPath !== setupPath) await goto(setupPath);
        if (setup.configured && currentPath === setupPath) await goto(loginPath);
        if (
          setup.configured &&
          currentPath === '/' &&
          sessionStorage.getItem(UI_VERSION_KEY) !== 'legacy'
        ) {
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
  {#if newRoute}
    <NewToaster theme="system" position="bottom-right" expand />
  {:else}
    <Toaster richColors theme="dark" position="bottom-right" expand />
  {/if}
</TooltipProvider>
