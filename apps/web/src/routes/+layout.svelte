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
  let toasterTheme = $state<'light' | 'dark'>('dark');
  let toasterPosition = $state<'top-center' | 'bottom-right'>('bottom-right');

  function routeTitle(pathname: string): string {
    const routes: Array<[string, string]> = [
      ['/dashboard/settings/profiles/new', 'New Profile Revision'],
      ['/dashboard/settings/connections', 'Connections'],
      ['/dashboard/settings/profiles', 'Profiles'],
      ['/dashboard/settings/people', 'People & Access'],
      ['/dashboard/settings/retention', 'Retention'],
      ['/dashboard/settings/network', 'Network'],
      ['/dashboard/settings/runtime', 'Runtime'],
      ['/dashboard/settings/api', 'API Access'],
      ['/dashboard/system/diagnostics', 'Diagnostics'],
      ['/dashboard/system/services', 'Storage & Routing'],
      ['/dashboard/system/nodes', 'Nodes'],
      ['/dashboard/system/work', 'Jobs & Cache'],
      ['/dashboard/relay/new', 'Advanced Relay'],
      ['/dashboard/sessions', 'Sessions'],
      ['/dashboard/live', 'Live'],
      ['/dashboard/setup', 'Setup'],
      ['/dashboard/login', 'Sign In'],
      ['/dashboard', 'Jellyfin']
    ];
    return (
      routes.find(([path]) => pathname === path || pathname.startsWith(`${path}/`))?.[1] ?? 'Home'
    );
  }

  afterNavigate(({ to }) => to && applyRouteTheme(to.url.pathname));

  onMount(() => {
    applyRouteTheme(page.url.pathname);
    const syncToasterTheme = () => {
      toasterTheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    };
    syncToasterTheme();
    document.addEventListener('vrrelay:theme', syncToasterTheme);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const syncSystemTheme = () => {
      if (readThemePreference() === 'system') applyRouteTheme(location.pathname);
    };
    media.addEventListener('change', syncSystemTheme);
    const mobileViewport = matchMedia('(max-width: 600px)');
    const syncToasterPosition = () => {
      toasterPosition = mobileViewport.matches ? 'top-center' : 'bottom-right';
    };
    syncToasterPosition();
    mobileViewport.addEventListener('change', syncToasterPosition);
    void (async () => {
      try {
        const setup = await api.setupStatus();
        const currentPath = location.pathname;
        const setupPath = '/dashboard/setup';
        const loginPath = '/dashboard/login';
        if (!setup.configured && currentPath !== setupPath) await goto(setupPath);
        if (setup.configured && currentPath === setupPath) await goto(loginPath);
        if (setup.configured && currentPath === '/') await goto('/dashboard');
      } catch {
        // The route itself will present a useful connection error.
      } finally {
        ready = true;
      }
    })();
    return () => {
      media.removeEventListener('change', syncSystemTheme);
      mobileViewport.removeEventListener('change', syncToasterPosition);
      document.removeEventListener('vrrelay:theme', syncToasterTheme);
    };
  });
</script>

<svelte:head>
  <title>{routeTitle(page.url.pathname)} · VRRelay</title>
  <meta
    name="description"
    content="Self-hosted Jellyfin VOD and OBS live relay for VRChat video players."
  />
</svelte:head>

<TooltipProvider>
  {#if ready}{@render children()}{/if}
  <Toaster theme={toasterTheme} position={toasterPosition} expand />
</TooltipProvider>
