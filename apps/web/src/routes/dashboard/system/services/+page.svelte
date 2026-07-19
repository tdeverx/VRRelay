<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import * as Card from '#lib/new-ui/components/ui/card';

  let backends = $state<Awaited<ReturnType<typeof api.clusterBackends>>['items']>([]);
  let loading = $state(true);
  onMount(async () => {
    try {
      backends = (await api.clusterBackends()).items;
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
      {#if !loading}<Card.Root
          ><Card.Header
            ><Card.Title>No services reported</Card.Title><Card.Description
              >The relay has not returned infrastructure health details.</Card.Description
            ></Card.Header
          ></Card.Root
        >{/if}
    {/each}
  </div>
</div>
