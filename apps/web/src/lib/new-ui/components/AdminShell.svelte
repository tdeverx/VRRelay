<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    Antenna,
    CircleGauge,
    Film,
    House,
    LogOut,
    Moon,
    Settings,
    Sun,
    SunMoon,
    UserRound
  } from '@lucide/svelte';
  import { api } from '#lib/api';
  import * as DropdownMenu from '#lib/new-ui/components/ui/dropdown-menu';
  import * as Sidebar from '#lib/new-ui/components/ui/sidebar';
  import { Separator } from '#lib/new-ui/components/ui/separator';
  import {
    readThemePreference,
    setThemePreference,
    type ThemePreference
  } from '#lib/new-ui/state.svelte';

  let { children, rail }: { children: Snippet; rail?: Snippet } = $props();
  let health = $state<Awaited<ReturnType<typeof api.health>> | null>(null);
  let theme = $state<ThemePreference>('system');
  let sidebarOpen = $state(false);
  let currentUser = $state<Awaited<ReturnType<typeof api.me>> | null>(null);

  let isOperator = $derived(
    Boolean(currentUser?.roles.some((role) => ['operator', 'admin', 'owner'].includes(role)))
  );
  let isAdmin = $derived(
    Boolean(currentUser?.roles.some((role) => role === 'admin' || role === 'owner'))
  );

  const routePrefix = '/dashboard';
  let groups = $derived(
    [
      {
        label: 'Use',
        items: [
          { label: 'Home', href: routePrefix, icon: House, visible: true },
          { label: 'Live', href: `${routePrefix}/live`, icon: Antenna, visible: true }
        ]
      },
      {
        label: 'Manage',
        items: [
          { label: 'Sessions', href: `${routePrefix}/sessions`, icon: Film, visible: true },
          {
            label: 'System',
            href: `${routePrefix}/system`,
            icon: CircleGauge,
            visible: isOperator
          },
          { label: 'Settings', href: `${routePrefix}/settings`, icon: Settings, visible: isAdmin }
        ]
      }
    ]
      .map((group) => ({ ...group, items: group.items.filter((item) => item.visible) }))
      .filter((group) => group.items.length > 0)
  );

  onMount(() => {
    const fullSidebar = matchMedia('(min-width: 1536px)');
    const syncSidebar = () => (sidebarOpen = fullSidebar.matches);
    syncSidebar();
    fullSidebar.addEventListener('change', syncSidebar);

    theme = readThemePreference();
    void api
      .health()
      .then((value) => (health = value))
      .catch(() => (health = null));
    void api
      .me()
      .then((value) => (currentUser = value))
      .catch(() => (location.href = '/dashboard/login'));

    return () => fullSidebar.removeEventListener('change', syncSidebar);
  });

  function updateTheme(value: unknown) {
    if (value === 'system' || value === 'light' || value === 'dark') {
      theme = value;
      setThemePreference(value);
    }
  }

  async function signOut() {
    await api.logout();
    location.href = '/dashboard/login';
  }
</script>

<a
  href="#new-main-content"
  class="bg-primary text-primary-foreground fixed start-2 top-2 z-50 -translate-y-20 rounded-md px-3 py-2 focus:translate-y-0"
>
  Skip to main content
</a>

<Sidebar.Provider bind:open={sidebarOpen}>
  <Sidebar.Root collapsible="icon">
    <Sidebar.Header>
      <Sidebar.Menu>
        <Sidebar.MenuItem>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Sidebar.MenuButton
                  {...props}
                  size="lg"
                  tooltipContent={currentUser?.displayName ?? 'Account'}
                >
                  <UserRound />
                  <span class="min-w-0">
                    <strong class="block truncate">{currentUser?.displayName ?? 'Account'}</strong>
                    <small class="text-muted-foreground block truncate">
                      {currentUser?.authMethod === 'recovery'
                        ? 'Recovery access'
                        : currentUser?.roles.join(' · ')}
                    </small>
                  </span>
                </Sidebar.MenuButton>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="right" align="start" class="w-56">
              <DropdownMenu.Label>{currentUser?.displayName ?? 'Account'}</DropdownMenu.Label>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onclick={signOut}><LogOut />Sign out</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.Header>
    <Sidebar.Content>
      {#each groups as group}
        <Sidebar.Group>
          <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
          <Sidebar.GroupContent>
            <Sidebar.Menu>
              {#each group.items as item}
                <Sidebar.MenuItem>
                  <Sidebar.MenuButton
                    isActive={page.url.pathname === item.href ||
                      (item.href !== routePrefix && page.url.pathname.startsWith(`${item.href}/`))}
                    tooltipContent={item.label}
                  >
                    {#snippet child({ props })}
                      <a href={item.href} {...props}>
                        <item.icon />
                        <span>{item.label}</span>
                      </a>
                    {/snippet}
                  </Sidebar.MenuButton>
                </Sidebar.MenuItem>
              {/each}
            </Sidebar.Menu>
          </Sidebar.GroupContent>
        </Sidebar.Group>
      {/each}
    </Sidebar.Content>
    <Sidebar.Footer>
      <Sidebar.Menu>
        <Sidebar.MenuItem>
          <div
            class="flex items-center gap-2 px-3 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          >
            <span
              class="size-2 rounded-full {health?.status === 'ok'
                ? 'bg-success'
                : 'bg-destructive'}"
              aria-hidden="true"
            ></span>
            <span class="min-w-0 group-data-[collapsible=icon]:hidden">
              <strong class="block truncate text-xs">
                {health?.status === 'ok' ? 'Relay reachable' : 'Relay unavailable'}
              </strong>
              <small class="text-muted-foreground block truncate">
                {health ? `VRRelay v${health.version}` : 'Version unavailable'}
              </small>
            </span>
          </div>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.Footer>
    <Sidebar.Rail />
  </Sidebar.Root>

  <Sidebar.Inset class="min-w-0">
    <header class="bg-background sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4">
      <Sidebar.Trigger class="md:hidden" aria-label="Open navigation" />
      <Sidebar.Trigger
        class="hidden md:inline-flex"
        aria-label={sidebarOpen ? 'Collapse navigation' : 'Expand navigation'}
      />
      <strong>VRRelay</strong>
      <div class="flex-1"></div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="hover:bg-accent inline-flex size-9 items-center justify-center rounded-md"
              aria-label="Choose theme"
            >
              {#if theme === 'light'}<Sun class="size-4" />{:else if theme === 'dark'}<Moon
                  class="size-4"
                />{:else}<SunMoon class="size-4" />{/if}
            </button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Label>Theme</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={theme} onValueChange={updateTheme}>
            <DropdownMenu.RadioItem value="system"><SunMoon />System</DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="light"><Sun />Light</DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="dark"><Moon />Dark</DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </header>
    <main id="new-main-content" tabindex="-1" class="min-w-0 flex-1">
      {@render children()}
    </main>
  </Sidebar.Inset>
  {#if rail}
    <aside class="hidden min-h-svh w-80 border-l 2xl:block">{@render rail()}</aside>
  {/if}
</Sidebar.Provider>
