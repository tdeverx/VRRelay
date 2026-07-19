<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Activity, Cpu, Database, Gauge } from '@lucide/svelte';
  import { api, isAuthenticatedError } from '#lib/api';
  import { adminRoute } from '#lib/new-ui/state.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Table from '#lib/new-ui/components/ui/table';
  import { Progress } from '#lib/new-ui/components/ui/progress';

  let health = $state<Awaited<ReturnType<typeof api.health>> | null>(null);
  let readiness = $state<Awaited<ReturnType<typeof api.readiness>> | null>(null);
  let capabilities = $state<Awaited<ReturnType<typeof api.capabilities>> | null>(null);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    try {
      [health, readiness, capabilities] = await Promise.all([
        api.health(),
        api.readiness(),
        api.capabilities()
      ]);
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(adminRoute(page.url.pathname, '/login'));
      error = reason instanceof Error ? reason.message : 'Could not load system details.';
    } finally {
      loading = false;
    }
  });
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Diagnostics"
    description="Runtime capacity, FFmpeg capabilities, cache and dependency health."
  />
  <LoadState {loading} {error} label="system details" variant="metrics" />
  {#if !loading && !error && health && capabilities}
    <section class="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Runtime summary">
      {#each [{ title: 'Relay', value: health.status, icon: Activity }, { title: 'Workers', value: `${health.workers.active} / ${health.workers.limit}`, icon: Gauge }, { title: 'Queue', value: String(health.workers.queued), icon: Database }, { title: 'FFmpeg', value: capabilities.ffmpegVersion, icon: Cpu }] as item}
        <Card.Root
          ><Card.Header
            ><Card.Description>{item.title}</Card.Description><Card.Title
              class="flex items-center gap-2"><item.icon class="size-5" />{item.value}</Card.Title
            ></Card.Header
          ></Card.Root
        >
      {/each}
    </section>
    <Card.Root>
      <Card.Header
        ><Card.Title>Worker capacity</Card.Title><Card.Description
          >{health.workers.active} active, {health.workers.queued} queued</Card.Description
        ></Card.Header
      >
      <Card.Content
        ><Progress
          value={health.workers.limit ? (health.workers.active / health.workers.limit) * 100 : 0}
          aria-label="Worker capacity"
        /></Card.Content
      >
    </Card.Root>
    <Card.Root>
      <Card.Header><Card.Title>Dependency health</Card.Title></Card.Header>
      <Card.Content class="p-0"
        ><Table.Root
          ><Table.Header
            ><Table.Row
              ><Table.Head>Dependency</Table.Head><Table.Head>Category</Table.Head><Table.Head
                >Status</Table.Head
              ><Table.Head>Restart</Table.Head></Table.Row
            ></Table.Header
          ><Table.Body
            >{#each readiness?.dependencies ?? [] as dependency}<Table.Row
                ><Table.Cell class="font-medium">{dependency.kind}</Table.Cell><Table.Cell
                  >{dependency.category}</Table.Cell
                ><Table.Cell
                  ><StatusBadge value={dependency.healthy ? 'healthy' : 'unhealthy'} /></Table.Cell
                ><Table.Cell>{dependency.restartRequired ? 'Required' : 'No'}</Table.Cell
                ></Table.Row
              >{/each}</Table.Body
          ></Table.Root
        ></Card.Content
      >
    </Card.Root>
    <Card.Root>
      <Card.Header
        ><Card.Title>FFmpeg encoders</Card.Title><Card.Description
          >{capabilities.muxers.length} muxers · {capabilities.filters.length} filters · {capabilities
            .pixelFormats.length} pixel formats</Card.Description
        ></Card.Header
      >
      <Card.Content class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
        >{#each capabilities.encoders as encoder}<div
            class="flex items-center justify-between rounded-lg border p-3 text-sm"
          >
            <span>{encoder.name}{encoder.hardware ? ' · hardware' : ''}</span><StatusBadge
              value={encoder.available ? 'available' : 'unavailable'}
            />
          </div>{/each}</Card.Content
      >
    </Card.Root>
  {/if}
</div>
