<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Ban, RefreshCw, ScrollText, Trash2 } from '@lucide/svelte';
  import type { JobLogEntry, SegmentJob } from '@vrrelay/domain';
  import { api } from '#lib/api';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import ConfirmAction from '#lib/new-ui/components/ConfirmAction.svelte';
  import { Badge } from '#lib/new-ui/components/ui/badge';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Dialog from '#lib/new-ui/components/ui/dialog';
  import * as ScrollArea from '#lib/new-ui/components/ui/scroll-area';

  let jobs = $state<Awaited<ReturnType<typeof api.segmentJobs>>['items']>([]);
  let producers = $state<Awaited<ReturnType<typeof api.vodProducers>>['items']>([]);
  let cacheItems = $state<Awaited<ReturnType<typeof api.cacheInventory>>['items']>([]);
  let totalBytes = $state(0);
  let loading = $state(true);
  let error = $state('');
  let confirmEviction = $state(false);
  let pendingCancel = $state<SegmentJob | null>(null);
  let logs = $state<JobLogEntry[]>([]);
  let logsOpen = $state(false);
  let logsJobId = $state('');
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
    try {
      await api.retrySegmentJob(id);
      await load();
      toast.success('Job queued again.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not retry the job.');
    }
  }
  async function cancel(job: SegmentJob) {
    await api.cancelSegmentJob(job.id);
    await load();
    toast.success('Job cancelled.');
  }
  async function showLogs(job: SegmentJob) {
    try {
      logs = (await api.jobLogs(job.id)).items;
      logsJobId = job.id;
      logsOpen = true;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load job logs.');
    }
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
        <Button
          variant="destructive"
          disabled={!cacheItems.length}
          onclick={() => (confirmEviction = true)}><Trash2 />Evict all</Button
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
            <div class="flex flex-wrap items-center gap-2">
              <StatusBadge value={job.state} />
              <Button variant="ghost" size="sm" onclick={() => showLogs(job)}>
                <ScrollText />Logs
              </Button>
              {#if ['queued', 'leased', 'running'].includes(job.state)}
                <Button variant="destructive" size="sm" onclick={() => (pendingCancel = job)}>
                  <Ban />Cancel
                </Button>
              {/if}
              {#if job.state === 'failed'}<Button variant="outline" onclick={() => retry(job.id)}
                  >Retry</Button
                >{/if}
            </div></Card.Header
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

<ConfirmAction
  bind:open={confirmEviction}
  title="Evict the entire media cache?"
  description={`Remove ${cacheItems.length} cached media objects (${(totalBytes / 1_073_741_824).toFixed(2)} GiB). Active viewers may need the relay to regenerate or restore them.`}
  confirmLabel="Evict all cached media"
  onConfirm={clearCache}
/>

<ConfirmAction
  open={Boolean(pendingCancel)}
  onOpenChange={(open) => !open && (pendingCancel = null)}
  title="Cancel segment job?"
  description={`Cancel ${pendingCancel?.id ?? 'this job'} and interrupt its current worker attempt. Later playback demand may queue a replacement.`}
  confirmLabel="Cancel job"
  onConfirm={async () => {
    if (!pendingCancel) return;
    await cancel(pendingCancel);
    pendingCancel = null;
  }}
/>

<Dialog.Root bind:open={logsOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Segment job logs</Dialog.Title>
      <Dialog.Description>{logsJobId} · bounded and secret-redacted</Dialog.Description>
    </Dialog.Header>
    <ScrollArea.Root class="max-h-96">
      <div class="flex flex-col gap-2 pr-4">
        {#each logs as log}
          <div class="flex items-start gap-3">
            <Badge variant="secondary">{log.level}</Badge>
            <div class="min-w-0">
              <p class="break-words text-sm">{log.message}</p>
              <p class="text-muted-foreground text-xs">
                {new Date(log.timestamp).toLocaleString()}
              </p>
            </div>
          </div>
        {:else}
          <p class="text-muted-foreground text-sm">No job logs have been recorded.</p>
        {/each}
      </div>
    </ScrollArea.Root>
  </Dialog.Content>
</Dialog.Root>
