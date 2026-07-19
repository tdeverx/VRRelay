<script lang="ts">
  import { KeyRound, Network, Plug, SlidersHorizontal, UsersRound, Wrench } from '@lucide/svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import * as Card from '#lib/new-ui/components/ui/card';

  const sections = [
    {
      title: 'People & access',
      description: 'Roles, profile access and sign-in activity.',
      href: '/dashboard/settings/people',
      icon: UsersRound
    },
    {
      title: 'Connections',
      description: 'Jellyfin connections, validation and placement.',
      href: '/dashboard/settings/connections',
      icon: Plug
    },
    {
      title: 'Profiles',
      description: 'Playback profiles, revisions and compatibility evidence.',
      href: '/dashboard/settings/profiles',
      icon: SlidersHorizontal
    },
    {
      title: 'Network',
      description: 'Listen addresses, public URLs and trusted proxies.',
      href: '/dashboard/settings/network',
      icon: Network
    },
    {
      title: 'Runtime',
      description: 'Node identity, capacity, cache policy and service actions.',
      href: '/dashboard/settings/runtime',
      icon: Wrench
    },
    {
      title: 'API access',
      description: 'Personal access tokens and scopes.',
      href: '/dashboard/settings/api',
      icon: KeyRound
    }
  ];
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader title="Settings" description="Configure access, connections and relay behaviour." />
  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
    {#each sections as section}
      <a
        href={section.href}
        class="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Card.Root class="h-full transition-colors group-hover:bg-muted/50">
          <Card.Header>
            <section.icon class="text-muted-foreground size-5" />
            <Card.Title>{section.title}</Card.Title>
            <Card.Description>{section.description}</Card.Description>
          </Card.Header>
        </Card.Root>
      </a>
    {/each}
  </div>
</div>
