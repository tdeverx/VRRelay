<script lang="ts">
  import { onMount } from 'svelte';
  import { Activity, Database, HardDrive, Network, ServerCog } from '@lucide/svelte';
  import { api } from '#lib/api';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import * as Card from '#lib/new-ui/components/ui/card';

  let readiness = $state<Awaited<ReturnType<typeof api.readiness>> | null>(null);
  let workers = $state({ active: 0, limit: 0, queued: 0 });
  onMount(async () => {
    const [ready, health] = await Promise.all([api.readiness(), api.health()]);
    readiness = ready;
    workers = health.workers;
  });
  const sections = [
    {
      title: 'Nodes',
      description: 'Enrollment, drain state, certificates and node logs.',
      href: '/dashboard/system/nodes',
      icon: ServerCog
    },
    {
      title: 'Storage & routing',
      description: 'Object storage, routing and dependency configuration.',
      href: '/dashboard/system/services',
      icon: Database
    },
    {
      title: 'Jobs & cache',
      description: 'Segment work, retries, logs and cached objects.',
      href: '/dashboard/system/work',
      icon: HardDrive
    },
    {
      title: 'Diagnostics',
      description: 'Capacity, versions and FFmpeg capability details.',
      href: '/dashboard/system/diagnostics',
      icon: Activity
    }
  ];
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader title="System" description="Operational health, infrastructure and diagnostics." />
  <section class="grid gap-3 sm:grid-cols-3" aria-label="System summary">
    <Card.Root
      ><Card.Header
        ><Card.Description>Relay</Card.Description><Card.Title
          ><StatusBadge value={readiness?.status ?? 'checking'} /></Card.Title
        ></Card.Header
      ></Card.Root
    >
    <Card.Root
      ><Card.Header
        ><Card.Description>Workers</Card.Description><Card.Title
          >{workers.active} / {workers.limit}</Card.Title
        ></Card.Header
      ></Card.Root
    >
    <Card.Root
      ><Card.Header
        ><Card.Description>Dependencies</Card.Description><Card.Title
          >{readiness?.dependencies.filter((item) => item.healthy).length ?? 0} / {readiness
            ?.dependencies.length ?? 0}</Card.Title
        ></Card.Header
      ></Card.Root
    >
  </section>
  <div class="grid gap-4 md:grid-cols-2">
    {#each sections as section}
      <a
        href={section.href}
        class="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Card.Root class="h-full transition-colors group-hover:bg-muted/50"
          ><Card.Header
            ><section.icon class="text-muted-foreground size-5" /><Card.Title
              >{section.title}</Card.Title
            ><Card.Description>{section.description}</Card.Description></Card.Header
          ></Card.Root
        >
      </a>
    {/each}
  </div>
</div>
