<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Activity, Cpu, Database, Gauge } from '@lucide/svelte';
  import { api, isAuthenticatedError } from '#lib/api';
  import { loginRoute } from '#lib/new-ui/state.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import * as Alert from '#lib/new-ui/components/ui/alert';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Table from '#lib/new-ui/components/ui/table';
  import { Progress } from '#lib/new-ui/components/ui/progress';

  let health = $state<Awaited<ReturnType<typeof api.health>> | null>(null);
  let readiness = $state<Awaited<ReturnType<typeof api.readiness>> | null>(null);
  let capabilities = $state<Awaited<ReturnType<typeof api.capabilities>> | null>(null);
  let loading = $state(true);
  let error = $state('');
  let warning = $state('');

  onMount(async () => {
    const results = await Promise.allSettled([
      api.health(),
      api.readiness(),
      api.capabilities()
    ] as const);
    const authenticationFailure = results.find(
      (result) => result.status === 'rejected' && isAuthenticatedError(result.reason)
    );
    if (authenticationFailure?.status === 'rejected') {
      loading = false;
      return goto(loginRoute(page.url.pathname));
    }
    const [healthResult, readinessResult, capabilityResult] = results;
    if (healthResult.status === 'fulfilled') health = healthResult.value;
    if (readinessResult.status === 'fulfilled') readiness = readinessResult.value;
    if (capabilityResult.status === 'fulfilled') capabilities = capabilityResult.value;
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) =>
        result.reason instanceof Error ? result.reason.message : 'A diagnostic section failed.'
      );
    if (!health && !readiness && !capabilities)
      error = failures[0] ?? 'Could not load system details.';
    else if (failures.length)
      warning = `Some diagnostic sections are unavailable: ${failures.join(' ')}`;
    loading = false;
  });
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Diagnostics"
    description="Runtime capacity, FFmpeg capabilities, cache and dependency health."
  />
  <LoadState {loading} {error} label="system details" variant="metrics" />
  {#if !loading && !error}
    {#if warning}
      <Alert.Root>
        <Alert.Title>Partial diagnostic data</Alert.Title>
        <Alert.Description>{warning}</Alert.Description>
      </Alert.Root>
    {/if}
    <section class="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Runtime summary">
      {#each [...(health ? [{ title: 'Relay', value: health.status, icon: Activity }, { title: 'Workers', value: `${health.workers.active} / ${health.workers.limit}`, icon: Gauge }, { title: 'Queue', value: String(health.workers.queued), icon: Database }] : []), ...(capabilities ? [{ title: 'FFmpeg', value: capabilities.ffmpegVersion, icon: Cpu }] : [])] as item}
        <Card.Root
          ><Card.Header
            ><Card.Description>{item.title}</Card.Description><Card.Title
              class="flex items-center gap-2"><item.icon class="size-5" />{item.value}</Card.Title
            ></Card.Header
          ></Card.Root
        >
      {/each}
    </section>
    {#if health}
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
    {/if}
    {#if readiness}
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
                    ><StatusBadge
                      value={dependency.healthy ? 'healthy' : 'unhealthy'}
                    /></Table.Cell
                  ><Table.Cell>{dependency.restartRequired ? 'Required' : 'No'}</Table.Cell
                  ></Table.Row
                >{/each}</Table.Body
            ></Table.Root
          ></Card.Content
        >
      </Card.Root>
    {/if}
    {#if capabilities}
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
  {/if}
</div>
