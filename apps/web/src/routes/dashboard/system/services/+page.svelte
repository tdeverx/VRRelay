<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import * as Card from '#lib/new-ui/components/ui/card';

  let backends = $state<Awaited<ReturnType<typeof api.clusterBackends>>['items']>([]);
  let loading = $state(true);
  let error = $state('');
  onMount(async () => {
    try {
      backends = (await api.clusterBackends()).items;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Could not load infrastructure services.';
    } finally {
      loading = false;
    }
  });
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Storage & routing"
    description="Active infrastructure services and their application state."
  />
  <LoadState {loading} {error} label="infrastructure services" variant="cards" count={2} />
  <div class="grid gap-3 md:grid-cols-2">
    {#each backends as backend}
      <Card.Root
        ><Card.Header
          ><div class="flex items-center justify-between gap-3">
            <Card.Title class="capitalize">{backend.category.replace('-', ' ')}</Card.Title
            ><StatusBadge value={backend.healthy ? 'healthy' : 'unhealthy'} />
          </div>
          <Card.Description
            >{backend.kind}{backend.message ? ` · ${backend.message}` : ''}</Card.Description
          ></Card.Header
        ></Card.Root
      >
    {:else}
      {#if !loading && !error}<Card.Root
          ><Card.Header
            ><Card.Title>No services reported</Card.Title><Card.Description
              >The relay has not returned infrastructure health details.</Card.Description
            ></Card.Header
          ></Card.Root
        >{/if}
    {/each}
  </div>
</div>
