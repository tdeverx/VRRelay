<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import {
    Activity,
    Antenna,
    Boxes,
    Network,
    ChevronLeft,
    CircleGauge,
    Film,
    Menu,
    Settings,
    SlidersHorizontal,
    TestTubeDiagonal,
    X
  } from '@lucide/svelte';
  import BrandMark from './BrandMark.svelte';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import { api } from '$lib/api';
  import { switchUi } from '$lib/new-ui/state.svelte';

  let {
    children,
    rail,
    bottom,
    active = ''
  }: { children: Snippet; rail?: Snippet; bottom?: Snippet; active?: string } = $props();
  let mobileOpen = $state(false);
  let collapsed = $state(false);
  let health = $state<{ status: string; version: string } | null>(null);
  let menuButton = $state<HTMLButtonElement | null>(null);
  let mobileCloseButton = $state<HTMLButtonElement | null>(null);

  onMount(async () => {
    collapsed = localStorage.getItem('vrrelay.navigation-collapsed') === 'true';
    try {
      health = await api.health();
    } catch {
      health = null;
    }
  });

  function toggleCollapsed() {
    collapsed = !collapsed;
    localStorage.setItem('vrrelay.navigation-collapsed', String(collapsed));
  }

  async function openMobileNavigation() {
    mobileOpen = true;
    await tick();
    mobileCloseButton?.focus();
  }

  function closeMobileNavigation() {
    mobileOpen = false;
    menuButton?.focus();
  }

  const navigation = [
    { id: 'sessions', label: 'Sessions', href: '/', icon: Film },
    { id: 'library', label: 'Library', href: '/library', icon: Boxes },
    { id: 'live', label: 'Live ingest', href: '/live', icon: Antenna },
    { id: 'cluster', label: 'Cluster', href: '/cluster', icon: Network },
    { id: 'profiles', label: 'Profiles', href: '/profiles', icon: SlidersHorizontal },
    { id: 'compatibility', label: 'Compatibility', href: '/compatibility', icon: TestTubeDiagonal },
    { id: 'system', label: 'System', href: '/system', icon: CircleGauge },
    { id: 'settings', label: 'Settings', href: '/settings', icon: Settings }
  ];
</script>

<svelte:window
  onkeydown={(event) => event.key === 'Escape' && mobileOpen && closeMobileNavigation()}
/>

<a class="skip-link" href="#main-content">Skip to main content</a>

<div
  class="app-shell"
  class:has-bottom={Boolean(bottom)}
  class:has-rail={Boolean(rail)}
  class:collapsed
  class:mobile-navigation={mobileOpen}
>
  <header class="mobile-header">
    <Button
      bind:ref={menuButton}
      variant="ghost"
      size="icon"
      aria-label="Open navigation"
      onclick={openMobileNavigation}
    >
      <Menu />
    </Button>
    <BrandMark />
  </header>

  {#if mobileOpen}
    <button class="scrim" aria-label="Dismiss navigation" onclick={closeMobileNavigation}></button>
  {/if}

  <aside class:open={mobileOpen} class="sidebar">
    <div class="sidebar-brand">
      <BrandMark compact={collapsed && !mobileOpen} />
      <Button
        variant="ghost"
        size="icon"
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-pressed={collapsed}
        class="desktop-collapse"
        onclick={toggleCollapsed}
      >
        <ChevronLeft />
      </Button>
      {#if mobileOpen}
        <Button
          bind:ref={mobileCloseButton}
          variant="ghost"
          size="icon"
          aria-label="Close navigation"
          class="mobile-close"
          onclick={closeMobileNavigation}
        >
          <X />
        </Button>
      {/if}
    </div>
    <nav aria-label="Primary navigation">
      {#each navigation as item}
        <a
          href={item.href}
          aria-label={collapsed && !mobileOpen ? item.label : undefined}
          aria-current={active === item.id || page.url.pathname === item.href ? 'page' : undefined}
          class={cn(
            'nav-item',
            active === item.id || page.url.pathname === item.href ? 'selected' : ''
          )}
          onclick={() => (mobileOpen = false)}
        >
          <item.icon />
          <span>{item.label}</span>
        </a>
      {/each}
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-status">
        <span class="health-dot"></span>
        <div>
          <strong>{health?.status === 'ok' ? 'Relay reachable' : 'Relay unavailable'}</strong>
          <small>{health ? `VRRelay v${health.version}` : 'VRRelay version unavailable'}</small>
        </div>
      </div>
      <Button variant="outline" onclick={() => switchUi(page.url.pathname, 'new')}
        >Try new UI</Button
      >
    </div>
  </aside>

  <main id="main-content" tabindex="-1">{@render children()}</main>
  {#if rail}<aside class="rail">{@render rail()}</aside>{/if}
  {#if bottom}<footer class="capacity">{@render bottom()}</footer>{/if}
</div>

<style>
  .skip-link {
    position: fixed;
    z-index: 100;
    top: 8px;
    left: 8px;
    transform: translateY(-160%);
    border-radius: 6px;
    padding: 10px 14px;
    background: var(--primary);
    color: var(--primary-foreground);
    font-weight: 650;
    text-decoration: none;
  }
  .skip-link:focus {
    transform: translateY(0);
  }
  .app-shell {
    display: grid;
    min-height: 100vh;
    grid-template-columns: 228px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    background: var(--background);
  }
  .app-shell.has-rail {
    grid-template-columns: 228px minmax(0, 1fr) 350px;
  }
  .app-shell.collapsed:not(.mobile-navigation) {
    grid-template-columns: 76px minmax(0, 1fr);
  }
  .app-shell.has-rail.collapsed:not(.mobile-navigation) {
    grid-template-columns: 76px minmax(0, 1fr) 350px;
  }
  .app-shell.has-bottom {
    grid-template-rows: minmax(0, 1fr) 154px;
  }
  .sidebar {
    grid-column: 1;
    grid-row: 1;
    display: flex;
    min-height: 0;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--sidebar);
  }
  .sidebar-brand {
    display: flex;
    height: 76px;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
  }
  .app-shell.collapsed:not(.mobile-navigation) .sidebar-brand {
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    height: 98px;
    padding: 8px;
  }
  .app-shell.collapsed:not(.mobile-navigation) .desktop-collapse :global(svg) {
    transform: rotate(180deg);
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 10px;
  }
  .nav-item {
    position: relative;
    display: flex;
    height: 48px;
    align-items: center;
    gap: 14px;
    border-radius: 6px;
    padding: 0 14px;
    color: var(--muted-foreground);
    font-size: 14px;
    font-weight: 530;
    text-decoration: none;
    transition: 150ms ease;
  }
  .app-shell.collapsed:not(.mobile-navigation) .nav-item {
    justify-content: center;
    padding: 0;
  }
  .app-shell.collapsed:not(.mobile-navigation) .nav-item span {
    display: none;
  }
  .nav-item :global(svg) {
    width: 19px;
    height: 19px;
    stroke-width: 1.7;
  }
  .nav-item:hover {
    background: color-mix(in oklab, var(--accent) 55%, transparent);
    color: var(--foreground);
  }
  .nav-item.selected {
    background: var(--surface-selected);
    color: var(--primary);
  }
  .nav-item.selected::before {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -10px;
    width: 2px;
    background: var(--primary);
    content: '';
  }
  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: auto;
    border-top: 1px solid var(--border);
    padding: 20px;
  }
  .sidebar-status {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .app-shell.collapsed:not(.mobile-navigation) .sidebar-footer {
    justify-content: center;
    padding: 20px 8px;
  }
  .app-shell.collapsed:not(.mobile-navigation) .sidebar-footer :global(button),
  .app-shell.collapsed:not(.mobile-navigation) .sidebar-status div {
    display: none;
  }
  .sidebar-status div {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .sidebar-status strong {
    font-size: 12px;
    font-weight: 570;
  }
  .sidebar-status small {
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .health-dot {
    width: 8px;
    height: 8px;
    margin-top: 4px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 10px color-mix(in oklab, var(--success) 40%, transparent);
  }
  main {
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .rail {
    grid-column: 3;
    grid-row: 1;
    min-width: 0;
    overflow: auto;
    border-left: 1px solid var(--border);
    background: color-mix(in oklab, var(--sidebar) 72%, var(--background));
  }
  .capacity {
    grid-column: 1 / -1;
    grid-row: 2;
    border-top: 1px solid var(--border);
    background: var(--sidebar);
  }
  .mobile-header,
  .mobile-close,
  .scrim {
    display: none;
  }
  @media (max-width: 1180px) {
    .app-shell.has-rail {
      grid-template-columns: 208px minmax(0, 1fr);
    }
    .app-shell.has-rail.collapsed:not(.mobile-navigation) {
      grid-template-columns: 76px minmax(0, 1fr);
    }
    .rail {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .app-shell,
    .app-shell.has-rail {
      display: block;
      padding-top: 58px;
    }
    .app-shell.has-bottom {
      padding-bottom: 0;
    }
    .mobile-header {
      position: fixed;
      z-index: 30;
      top: 0;
      right: 0;
      left: 0;
      display: flex;
      height: 58px;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--border);
      padding: 0 12px;
      background: var(--sidebar);
    }
    .sidebar {
      position: fixed;
      z-index: 50;
      top: 0;
      bottom: 0;
      left: 0;
      width: 260px;
      transform: translateX(-100%);
      transition: transform 160ms ease;
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .desktop-collapse {
      display: none;
    }
    .mobile-close {
      display: inline-flex;
    }
    .scrim {
      position: fixed;
      z-index: 40;
      inset: 0;
      display: block;
      border: 0;
      background: rgb(0 0 0 / 0.62);
    }
    main {
      overflow: visible;
    }
    .capacity {
      display: none;
    }
  }
</style>
