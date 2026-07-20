<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { RefreshCw, Trash2 } from '@lucide/svelte';
  import { api } from '#lib/api';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';

  let jobs = $state<Awaited<ReturnType<typeof api.segmentJobs>>['items']>([]);
  let producers = $state<Awaited<ReturnType<typeof api.vodProducers>>['items']>([]);
  let cacheItems = $state<Awaited<ReturnType<typeof api.cacheInventory>>['items']>([]);
  let totalBytes = $state(0);
  let loading = $state(true);
  let error = $state('');
  onMount(load);
  async function load() {
    loading = true;
    try {
      const [jobResult, producerResult, cacheResult] = await Promise.all([
        api.segmentJobs(),
        api.vodProducers(),
        api.cacheInventory()
      ]);
      jobs = jobResult.items;
      producers = producerResult.items;
      cacheItems = cacheResult.items;
      totalBytes = cacheResult.totalBytes;
      error = '';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Could not load jobs and cache.';
    } finally {
      loading = false;
    }
  }
  async function retry(id: string) {
    await api.retrySegmentJob(id);
    await load();
    toast.success('Job queued again.');
  }
  async function clearCache() {
    const result = await api.evictCache({ all: true });
    await load();
    toast.success(`${result.removed} cached objects removed.`);
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader title="Jobs & cache" description="Operational work and temporary media objects.">
    {#snippet actions()}<Button variant="outline" onclick={load}><RefreshCw />Refresh</Button
      >{/snippet}
  </PageHeader>
  <LoadState {loading} {error} label="jobs and cache" variant="cards" />
  {#if !loading && !error}
    <Card.Root
      ><Card.Header class="sm:flex-row sm:items-center"
        ><div class="flex-1">
          <Card.Title>Cache</Card.Title><Card.Description
            >{cacheItems.length} objects · {(totalBytes / 1_073_741_824).toFixed(2)} GiB</Card.Description
          >
        </div>
        <Button variant="destructive" disabled={!cacheItems.length} onclick={clearCache}
          ><Trash2 />Evict all</Button
        ></Card.Header
      ></Card.Root
    >
    <div class="grid gap-3">
      {#each producers as producer}
        <Card.Root
          ><Card.Header class="sm:flex-row sm:items-center"
            ><div class="min-w-0 flex-1">
              <Card.Title class="truncate">VOD producer · {producer.sessionId}</Card.Title
              ><Card.Description
                >Source worker {producer.ownerNodeId ?? 'unassigned'} · generation
                {producer.generation} · window {producer.startSegmentIndex}–{producer.lastPublishedSegmentIndex ??
                  'waiting'}
                · demand {new Date(
                  producer.lastDemandAt
                ).toLocaleString()}{#if producer.errorMessage}
                  · {producer.errorMessage}{/if}</Card.Description
              >
            </div>
            <StatusBadge value={producer.state} /></Card.Header
          ></Card.Root
        >
      {:else}<Card.Root
          ><Card.Header
            ><Card.Title>No VOD producers</Card.Title><Card.Description
              >A durable source producer appears after the first uncached VOD segment demand.</Card.Description
            ></Card.Header
          ></Card.Root
        >{/each}
    </div>
    <div class="grid gap-3">
      {#each jobs as job}
        <Card.Root
          ><Card.Header class="sm:flex-row sm:items-center"
            ><div class="min-w-0 flex-1">
              <Card.Title class="truncate">{job.id}</Card.Title><Card.Description
                >{job.sessionId}</Card.Description
              >
            </div>
            <StatusBadge value={job.state} />{#if job.state === 'failed'}<Button
                variant="outline"
                onclick={() => retry(job.id)}>Retry</Button
              >{/if}</Card.Header
          ></Card.Root
        >
      {:else}<Card.Root
          ><Card.Header
            ><Card.Title>No segment jobs</Card.Title><Card.Description
              >There is no queued or recent distributed work.</Card.Description
            ></Card.Header
          ></Card.Root
        >{/each}
    </div>
  {/if}
</div>
