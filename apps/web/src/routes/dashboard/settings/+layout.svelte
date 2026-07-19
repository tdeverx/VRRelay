<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    KeyRound,
    LayoutDashboard,
    Network,
    Plug,
    SlidersHorizontal,
    UsersRound,
    Wrench
  } from '@lucide/svelte';
  import * as Select from '#lib/new-ui/components/ui/select';

  let { children }: { children: Snippet } = $props();

  const groups: Array<{
    label: string;
    items: Array<{ label: string; href: string; icon: Component }>;
  }> = [
    {
      label: 'Settings',
      items: [
        { label: 'Overview', href: '/dashboard/settings', icon: LayoutDashboard },
        { label: 'People & access', href: '/dashboard/settings/people', icon: UsersRound },
        { label: 'API access', href: '/dashboard/settings/api', icon: KeyRound }
      ]
    },
    {
      label: 'Relay',
      items: [
        { label: 'Connections', href: '/dashboard/settings/connections', icon: Plug },
        { label: 'Profiles', href: '/dashboard/settings/profiles', icon: SlidersHorizontal }
      ]
    },
    {
      label: 'Application',
      items: [
        { label: 'Network', href: '/dashboard/settings/network', icon: Network },
        { label: 'Runtime', href: '/dashboard/settings/runtime', icon: Wrench }
      ]
    }
  ];

  const items = groups.flatMap((group) => group.items);
  let selected = $derived(
    items.find(
      (item) =>
        page.url.pathname === item.href ||
        (item.href !== '/dashboard/settings' && page.url.pathname.startsWith(`${item.href}/`))
    )?.href ?? '/dashboard/settings'
  );
</script>

<div class="min-h-[calc(100svh-3.5rem)] md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
  <aside class="bg-muted/20 hidden border-r md:block">
    <nav class="sticky top-14 space-y-6 p-4" aria-label="Settings">
      {#each groups as group}
        <div class="space-y-1">
          <p class="text-muted-foreground px-2 text-xs font-medium">{group.label}</p>
          {#each group.items as item}
            <a
              href={item.href}
              aria-current={selected === item.href ? 'page' : undefined}
              class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors {selected ===
              item.href
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground'}"
            >
              <item.icon class="size-4" />
              <span>{item.label}</span>
            </a>
          {/each}
        </div>
      {/each}
    </nav>
  </aside>
  <div class="min-w-0">
    <div class="border-b p-4 md:hidden">
      <Select.Root
        type="single"
        value={selected}
        onValueChange={(value) => value && void goto(value)}
      >
        <Select.Trigger class="w-full" aria-label="Settings page">
          {items.find((item) => item.href === selected)?.label ?? 'Settings'}
        </Select.Trigger>
        <Select.Content>
          {#each groups as group}
            <Select.Group>
              <Select.Label>{group.label}</Select.Label>
              {#each group.items as item}
                <Select.Item value={item.href}>{item.label}</Select.Item>
              {/each}
            </Select.Group>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    {@render children()}
  </div>
</div>
