<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    Activity,
    Antenna,
    Boxes,
    CircleGauge,
    Film,
    Moon,
    MoonStar,
    Network,
    Settings,
    SlidersHorizontal,
    Sun,
    SunMoon,
    TestTubeDiagonal,
    UserRound
  } from '@lucide/svelte';
  import { api } from '$lib/api';
  import * as DropdownMenu from '$lib/new-ui/components/ui/dropdown-menu';
  import * as Sidebar from '$lib/new-ui/components/ui/sidebar';
  import * as Select from '$lib/new-ui/components/ui/select';
  import { Switch } from '$lib/new-ui/components/ui/switch';
  import { Separator } from '$lib/new-ui/components/ui/separator';
  import {
    readThemePreference,
    setThemePreference,
    switchUi,
    type ThemePreference
  } from '$lib/new-ui/state.svelte';

  let { children, rail }: { children: Snippet; rail?: Snippet } = $props();
  let health = $state<Awaited<ReturnType<typeof api.health>> | null>(null);
  let theme = $state<ThemePreference>('system');
  let sidebarOpen = $state(false);

  let routePrefix = $derived(page.url.pathname.startsWith('/dashboard') ? '/dashboard' : '/new');
  let groups = $derived([
    {
      label: 'Operate',
      items: [
        { label: 'Sessions', href: routePrefix, icon: Film },
        { label: 'Library', href: `${routePrefix}/library`, icon: Boxes },
        { label: 'Live', href: `${routePrefix}/live`, icon: Antenna }
      ]
    },
    {
      label: 'Infrastructure',
      items: [
        { label: 'Cluster', href: `${routePrefix}/cluster`, icon: Network },
        { label: 'System', href: `${routePrefix}/system`, icon: CircleGauge }
      ]
    },
    {
      label: 'Configure',
      items: [
        { label: 'Profiles', href: `${routePrefix}/profiles`, icon: SlidersHorizontal },
        { label: 'Compatibility', href: `${routePrefix}/compatibility`, icon: TestTubeDiagonal },
        { label: 'Settings', href: `${routePrefix}/settings`, icon: Settings },
        { label: 'User portal', href: '/portal', icon: UserRound }
      ]
    }
  ]);

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

    return () => fullSidebar.removeEventListener('change', syncSidebar);
  });

  function updateTheme(value: unknown) {
    if (value === 'system' || value === 'light' || value === 'dark') {
      theme = value;
      setThemePreference(value);
    }
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
          <Sidebar.MenuButton
            size="lg"
            tooltipContent="VRRelay"
            aria-label="VRRelay Luma preview"
            class="group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0"
          >
            <Activity />
            <span class="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
              <strong>VRRelay</strong>
              <small class="text-muted-foreground">Luma preview</small>
            </span>
          </Sidebar.MenuButton>
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
                    isActive={page.url.pathname === item.href}
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
      <Separator />
      <div class="space-y-2 group-data-[collapsible=icon]:hidden">
        <label class="text-muted-foreground flex items-center gap-2 text-xs" for="theme-choice">
          <MoonStar class="size-4" /> Theme
        </label>
        <Select.Root type="single" value={theme} onValueChange={updateTheme}>
          <Select.Trigger id="theme-choice" class="w-full">
            {theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="system">System</Select.Item>
            <Select.Item value="light">Light</Select.Item>
            <Select.Item value="dark">Dark</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
      <Sidebar.Menu class="hidden group-data-[collapsible=icon]:flex">
        <Sidebar.MenuItem>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Sidebar.MenuButton {...props} tooltipContent="Theme" aria-label="Choose theme">
                  {#if theme === 'light'}
                    <Sun />
                  {:else if theme === 'dark'}
                    <Moon />
                  {:else}
                    <SunMoon />
                  {/if}
                  <span>Theme</span>
                </Sidebar.MenuButton>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="right" align="end">
              <DropdownMenu.Group>
                <DropdownMenu.Label>Theme</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={theme} onValueChange={updateTheme}>
                  <DropdownMenu.RadioItem value="system">
                    <SunMoon />
                    System
                  </DropdownMenu.RadioItem>
                  <DropdownMenu.RadioItem value="light">
                    <Sun />
                    Light
                  </DropdownMenu.RadioItem>
                  <DropdownMenu.RadioItem value="dark">
                    <Moon />
                    Dark
                  </DropdownMenu.RadioItem>
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Group>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
      <div
        class="flex items-center justify-between gap-2 px-1 py-2 group-data-[collapsible=icon]:hidden"
      >
        <label for="new-ui-preview" class="text-sm">New interface</label>
        <Switch
          id="new-ui-preview"
          checked
          aria-label="Use legacy interface"
          onCheckedChange={(checked) => !checked && switchUi(page.url.pathname, 'legacy')}
        />
      </div>
    </Sidebar.Footer>
    <Sidebar.Rail />
  </Sidebar.Root>

  <Sidebar.Inset class="min-w-0">
    <header
      class="bg-background sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 2xl:hidden"
    >
      <Sidebar.Trigger class="md:hidden" aria-label="Open navigation" />
      <Sidebar.Trigger
        class="hidden md:inline-flex"
        aria-label={sidebarOpen ? 'Collapse navigation' : 'Expand navigation'}
      />
      <strong>VRRelay</strong>
    </header>
    <main id="new-main-content" tabindex="-1" class="min-w-0 flex-1">
      {@render children()}
    </main>
  </Sidebar.Inset>
  {#if rail}
    <aside class="hidden min-h-svh w-80 border-l 2xl:block">{@render rail()}</aside>
  {/if}
</Sidebar.Provider>
