<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    Cloud,
    Copy,
    Database,
    KeyRound,
    Network,
    Plus,
    RefreshCw,
    RotateCcw,
    ScrollText,
    Settings2,
    ShieldX,
    Square,
    Trash2
  } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type {
    AgentLogEntry,
    BackendStatus,
    CachedObject,
    ClusterNode,
    JobLogEntry,
    PublicProviderBinding,
    PublicProviderConnection,
    SegmentJob
  } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import { adminRoute } from '#lib/new-ui/state.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import { Badge } from '#lib/new-ui/components/ui/badge';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Dialog from '#lib/new-ui/components/ui/dialog';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as ScrollArea from '#lib/new-ui/components/ui/scroll-area';
  import * as Select from '#lib/new-ui/components/ui/select';
  import { Switch } from '#lib/new-ui/components/ui/switch';
  import * as Tabs from '#lib/new-ui/components/ui/tabs';
  import * as Table from '#lib/new-ui/components/ui/table';

  let nodes = $state<Array<ClusterNode & { agent: { connected: boolean; connectedAt?: string } }>>(
    []
  );
  let backends = $state<BackendStatus[]>([]);
  let jobs = $state<SegmentJob[]>([]);
  let bindings = $state<PublicProviderBinding[]>([]);
  let providers = $state<PublicProviderConnection[]>([]);
  let cache = $state<CachedObject[]>([]);
  let cacheBytes = $state(0);
  let loading = $state(true);
  let error = $state('');
  let busyId = $state('');
  let enrollOpen = $state(false);
  let nodeName = $state('New edge');
  let region = $state('local');
  let joinResult = $state<{ token: string; expiresAt: string } | null>(null);
  let nodeRole = $state<'source-worker' | 'ingest-origin' | 'edge'>('edge');
  let bindOpen = $state(false);
  let bindNodeId = $state('');
  let bindProviderId = $state('new');
  let bindName = $state('Jellyfin');
  let bindUrl = $state('');
  let bindUsername = $state('');
  let bindPassword = $state('');
  let nodeLogs = $state<AgentLogEntry[]>([]);
  let logsOpen = $state(false);
  let jobLogs = $state<JobLogEntry[]>([]);
  let jobLogsOpen = $state(false);
  let jobLogsTitle = $state('Segment job logs');
  let backendOpen = $state(false);
  let routingKind = $state<'builtin' | 'static' | 'webhook'>('builtin');
  let routingEndpoint = $state('');
  let routingSecretRef = $state('');
  let routingNodeId = $state('');
  let routingRegion = $state('');
  let backendResult = $state<BackendStatus | null>(null);
  let backendBusy = $state(false);
  let storageOpen = $state(false);
  let storageKind = $state<'local' | 's3' | 'azure-blob' | 'gcs'>('local');
  let storageEndpoint = $state('');
  let storageBucket = $state('');
  let storageContainer = $state('');
  let storageRegion = $state('');
  let storagePrefix = $state('vrrelay');
  let storageProjectId = $state('');
  let storageSecretRef = $state('');
  let storageForcePathStyle = $state(true);
  let storageResult = $state<BackendStatus | null>(null);
  let storageBusy = $state(false);
  let cacheTargetId = $state('__local__');
  let cacheLoading = $state(false);

  let sourceWorkers = $derived(
    nodes.filter((node) => node.roles.includes('source-worker') && node.agent.connected)
  );
  let cacheNodes = $derived(
    nodes.filter(
      (node) =>
        node.agent.connected &&
        (node.roles.includes('edge') || node.roles.includes('source-worker'))
    )
  );
  let edgeNodes = $derived(nodes.filter((node) => node.roles.includes('edge')));
  let cacheTargetLabel = $derived(
    cacheTargetId === '__local__'
      ? 'Local cache'
      : (nodes.find((node) => node.id === cacheTargetId)?.name ?? cacheTargetId)
  );

  onMount(load);

  async function load() {
    try {
      const [nodeResult, backendResult, jobResult, bindingResult, providerResult] =
        await Promise.all([
          api.clusterNodes(),
          api.clusterBackends(),
          api.segmentJobs(),
          api.providerBindings(),
          api.providers()
        ]);
      nodes = nodeResult.items;
      backends = backendResult.items;
      jobs = jobResult.items;
      bindings = bindingResult.items;
      providers = providerResult.items;
      if (
        cacheTargetId !== '__local__' &&
        !nodeResult.items.some(
          (node) =>
            node.id === cacheTargetId &&
            node.agent.connected &&
            (node.roles.includes('edge') || node.roles.includes('source-worker'))
        )
      ) {
        cacheTargetId = '__local__';
      }
      await loadCache(cacheTargetId);
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(adminRoute(page.url.pathname, '/login'));
      error = reason instanceof Error ? reason.message : 'Could not load cluster.';
    } finally {
      loading = false;
    }
  }

  async function loadCache(targetId = cacheTargetId) {
    cacheLoading = true;
    try {
      const result = await api.cacheInventory(targetId === '__local__' ? undefined : targetId);
      cache = result.items;
      cacheBytes = result.totalBytes;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load cache inventory.');
    } finally {
      cacheLoading = false;
    }
  }

  async function createJoinToken() {
    try {
      joinResult = await api.createNodeJoinToken({
        name: nodeName,
        roles: [nodeRole],
        region,
        expiresInSeconds: 600
      });
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not create join token.');
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    toast.success('Copied to clipboard.');
  }

  async function drain(node: ClusterNode) {
    busyId = node.id;
    try {
      const updated = await api.drainNode(node.id, node.state !== 'draining');
      nodes = nodes.map((candidate) =>
        candidate.id === updated.id ? { ...candidate, ...updated } : candidate
      );
      toast.success(updated.state === 'draining' ? 'Node draining.' : 'Node drain cancelled.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not update node.');
    } finally {
      busyId = '';
    }
  }

  async function rotate(node: ClusterNode) {
    busyId = node.id;
    try {
      await api.rotateNodeCertificate(node.id);
      await load();
      toast.success('Node certificate rotated.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not rotate certificate.');
    } finally {
      busyId = '';
    }
  }

  async function revoke(node: ClusterNode) {
    busyId = node.id;
    try {
      await api.revokeNode(node.id);
      await load();
      toast.success('Node revoked.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not revoke node.');
    } finally {
      busyId = '';
    }
  }

  async function showLogs(node: ClusterNode) {
    try {
      nodeLogs = (await api.nodeLogs(node.id)).items;
      logsOpen = true;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load node logs.');
    }
  }

  async function showJobLogs(job: SegmentJob) {
    try {
      jobLogs = (await api.jobLogs(job.id)).items;
      jobLogsTitle = `Segment ${job.segmentIndex} logs`;
      jobLogsOpen = true;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load job logs.');
    }
  }

  async function createBinding() {
    try {
      await api.createProviderBinding({
        ...(bindProviderId !== 'new' ? { providerId: bindProviderId } : {}),
        nodeId: bindNodeId,
        type: 'jellyfin',
        name: bindName,
        baseUrl: bindUrl,
        authMode: 'user_token',
        username: bindUsername,
        password: bindPassword,
        allowPublicHttp: false
      });
      bindPassword = '';
      bindOpen = false;
      await load();
      toast.success('Provider credentials stored on the selected worker.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not bind provider.');
    }
  }

  function routingRequest() {
    return {
      category: 'routing' as const,
      kind: routingKind,
      ...(routingKind === 'static' && routingNodeId ? { nodeId: routingNodeId } : {}),
      ...(routingKind === 'static' && routingRegion ? { region: routingRegion } : {}),
      ...(routingKind === 'webhook' ? { endpoint: routingEndpoint } : {}),
      ...(routingKind === 'webhook' && routingSecretRef ? { secretRef: routingSecretRef } : {})
    };
  }

  async function validateRouting() {
    backendBusy = true;
    try {
      backendResult = await api.validateBackend(routingRequest());
      toast[backendResult.healthy ? 'success' : 'error'](
        backendResult.healthy
          ? 'Routing backend is reachable.'
          : (backendResult.message ?? 'Routing backend validation failed.')
      );
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not validate routing backend.');
    } finally {
      backendBusy = false;
    }
  }

  async function activateRouting() {
    backendBusy = true;
    try {
      backendResult = await api.activateBackend(routingRequest());
      backendOpen = false;
      await load();
      toast.success('Routing backend activated.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not activate routing backend.');
    } finally {
      backendBusy = false;
    }
  }

  function storageRequest() {
    return {
      category: 'object-store' as const,
      kind: storageKind,
      ...(storageEndpoint ? { endpoint: storageEndpoint } : {}),
      ...(storageBucket ? { bucket: storageBucket } : {}),
      ...(storageContainer ? { container: storageContainer } : {}),
      ...(storageRegion ? { region: storageRegion } : {}),
      ...(storagePrefix ? { prefix: storagePrefix } : {}),
      ...(storageProjectId ? { projectId: storageProjectId } : {}),
      ...(storageSecretRef ? { secretRef: storageSecretRef } : {}),
      ...(storageKind === 's3' ? { forcePathStyle: storageForcePathStyle } : {})
    };
  }

  function storageReady() {
    if (storageKind === 'local') return true;
    if (storageKind === 'azure-blob') return Boolean(storageEndpoint && storageContainer);
    return Boolean(storageBucket);
  }

  async function validateStorage() {
    storageBusy = true;
    try {
      storageResult = await api.validateBackend(storageRequest());
      toast[storageResult.healthy ? 'success' : 'error'](
        storageResult.healthy
          ? 'Object store is reachable.'
          : (storageResult.message ?? 'Object-store validation failed.')
      );
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not validate object store.');
    } finally {
      storageBusy = false;
    }
  }

  async function activateStorage() {
    storageBusy = true;
    try {
      storageResult = await api.activateBackend(storageRequest());
      storageOpen = false;
      await load();
      toast.success('Object store staged. Restart every relay role to activate it.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not stage object store.');
    } finally {
      storageBusy = false;
    }
  }

  async function evictAll() {
    busyId = 'cache';
    try {
      const result = await api.evictCache({
        all: true,
        ...(cacheTargetId === '__local__' ? {} : { nodeId: cacheTargetId })
      });
      await loadCache();
      toast.success(`Evicted ${result.removed} objects.`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not evict cache.');
    } finally {
      busyId = '';
    }
  }

  async function cancelJob(job: SegmentJob) {
    busyId = job.id;
    try {
      await api.cancelSegmentJob(job.id);
      await load();
      toast.success('Job cancelled.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not cancel job.');
    } finally {
      busyId = '';
    }
  }

  async function retryJob(job: SegmentJob) {
    busyId = job.id;
    try {
      const updated = await api.retrySegmentJob(job.id);
      jobs = jobs.map((candidate) => (candidate.id === updated.id ? updated : candidate));
      toast.success('Job queued again.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not retry job.');
    } finally {
      busyId = '';
    }
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Cluster"
    description="Nodes, platform backends, segment work, provider bindings and cache inventory."
  >
    {#snippet actions()}
      <Button variant="outline" disabled={loading} onclick={() => load()}>
        <RefreshCw data-icon="inline-start" />Refresh
      </Button>
      <Button
        variant="outline"
        onclick={() => {
          bindNodeId = sourceWorkers[0]?.id ?? '';
          bindOpen = true;
        }}
      >
        <KeyRound data-icon="inline-start" />Bind provider
      </Button>
      <Button
        onclick={() => {
          joinResult = null;
          enrollOpen = true;
        }}
      >
        <Plus data-icon="inline-start" />Enroll node
      </Button>
    {/snippet}
  </PageHeader>
  <LoadState {loading} {error} label="cluster" />
  {#if !loading && !error}
    <section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Cluster summary">
      {#each [{ label: 'Nodes', value: nodes.length, icon: Network }, { label: 'Healthy backends', value: backends.filter((item) => item.healthy).length, icon: Database }, { label: 'Active jobs', value: jobs.filter( (item) => ['queued', 'leased', 'running'].includes(item.state) ).length, icon: RotateCcw }, { label: 'Cache', value: `${(cacheBytes / 1024 / 1024).toFixed(1)} MB`, icon: Database }] as metric}
        <Card.Root
          ><Card.Header
            ><Card.Description>{metric.label}</Card.Description><Card.Title
              class="flex items-center gap-2"
              ><metric.icon class="size-5" />{metric.value}</Card.Title
            ></Card.Header
          ></Card.Root
        >
      {/each}
    </section>

    <Tabs.Root value="nodes">
      <Tabs.List class="w-full justify-start overflow-x-auto">
        <Tabs.Trigger value="nodes">Nodes</Tabs.Trigger><Tabs.Trigger value="backends"
          >Backends</Tabs.Trigger
        ><Tabs.Trigger value="jobs">Segment Jobs</Tabs.Trigger><Tabs.Trigger value="bindings"
          >Provider Bindings</Tabs.Trigger
        ><Tabs.Trigger value="cache">Cache</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="nodes"
        ><div class="hidden overflow-hidden rounded-xl border md:block">
          <Table.Root
            ><Table.Header
              ><Table.Row
                ><Table.Head>Node</Table.Head><Table.Head>Region</Table.Head><Table.Head
                  >Roles</Table.Head
                ><Table.Head>Workers</Table.Head><Table.Head>Status</Table.Head><Table.Head
                ></Table.Head></Table.Row
              ></Table.Header
            ><Table.Body
              >{#each nodes as node}<Table.Row
                  ><Table.Cell class="font-medium">{node.name}</Table.Cell><Table.Cell
                    >{node.region}</Table.Cell
                  ><Table.Cell>{node.roles.join(', ')}</Table.Cell><Table.Cell
                    >{node.capabilities.activeWorkers}/{node.capabilities.maxWorkers}</Table.Cell
                  ><Table.Cell><StatusBadge value={node.state} /></Table.Cell><Table.Cell
                    ><div class="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === node.id}
                        onclick={() => drain(node)}
                        >{node.state === 'draining' ? 'Cancel drain' : 'Drain'}</Button
                      >
                      {#if !node.roles.includes('controller')}
                        <Button variant="ghost" size="sm" onclick={() => showLogs(node)}>
                          <ScrollText data-icon="inline-start" />Logs
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === node.id}
                          onclick={() => rotate(node)}>Rotate</Button
                        >
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busyId === node.id}
                          onclick={() => revoke(node)}
                        >
                          <ShieldX data-icon="inline-start" />Revoke
                        </Button>
                      {/if}
                    </div></Table.Cell
                  ></Table.Row
                >{/each}</Table.Body
            ></Table.Root
          >
        </div>
        <div class="grid gap-3 md:hidden">
          {#each nodes as node}<Card.Root
              ><Card.Header
                ><Card.Title>{node.name}</Card.Title><Card.Description
                  >{node.region} · {node.roles.join(', ')}</Card.Description
                ><Card.Action><StatusBadge value={node.state} /></Card.Action></Card.Header
              ><Card.Footer class="flex flex-wrap gap-2"
                ><Button variant="outline" size="sm" onclick={() => drain(node)}
                  >{node.state === 'draining' ? 'Cancel drain' : 'Drain node'}</Button
                >{#if !node.roles.includes('controller')}<Button
                    variant="outline"
                    size="sm"
                    onclick={() => showLogs(node)}>Logs</Button
                  ><Button variant="outline" size="sm" onclick={() => rotate(node)}>Rotate</Button
                  ><Button variant="destructive" size="sm" onclick={() => revoke(node)}
                    >Revoke</Button
                  >{/if}</Card.Footer
              ></Card.Root
            >{/each}
        </div></Tabs.Content
      >

      <Tabs.Content value="backends"
        ><div class="mb-3 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onclick={() => (storageOpen = true)}>
            <Cloud data-icon="inline-start" />Configure storage
          </Button>
          <Button variant="outline" onclick={() => (backendOpen = true)}>
            <Settings2 data-icon="inline-start" />Configure routing
          </Button>
        </div>
        <div class="hidden overflow-hidden rounded-xl border md:block">
          <Table.Root
            ><Table.Header
              ><Table.Row
                ><Table.Head>Category</Table.Head><Table.Head>Kind</Table.Head><Table.Head
                  >Status</Table.Head
                ><Table.Head>Message</Table.Head></Table.Row
              ></Table.Header
            ><Table.Body
              >{#each backends as backend}<Table.Row
                  ><Table.Cell class="font-medium">{backend.category}</Table.Cell><Table.Cell
                    >{backend.kind}</Table.Cell
                  ><Table.Cell
                    ><StatusBadge value={backend.healthy ? 'healthy' : 'unhealthy'} /></Table.Cell
                  ><Table.Cell>{backend.message ?? '—'}</Table.Cell></Table.Row
                >{/each}</Table.Body
            ></Table.Root
          >
        </div>
        <div class="grid gap-3 md:hidden">
          {#each backends as backend}<Card.Root
              ><Card.Header
                ><Card.Title>{backend.category}</Card.Title><Card.Description
                  >{backend.kind} · {backend.message ?? 'Connected'}</Card.Description
                ><Card.Action
                  ><StatusBadge value={backend.healthy ? 'healthy' : 'unhealthy'} /></Card.Action
                ></Card.Header
              ></Card.Root
            >{/each}
        </div></Tabs.Content
      >

      <Tabs.Content value="jobs"
        ><div class="overflow-hidden rounded-xl border">
          <Table.Root
            ><Table.Header
              ><Table.Row
                ><Table.Head>Job</Table.Head><Table.Head>Segment</Table.Head><Table.Head
                  >Owner</Table.Head
                ><Table.Head>Status</Table.Head><Table.Head></Table.Head></Table.Row
              ></Table.Header
            ><Table.Body
              >{#each jobs as job}<Table.Row
                  ><Table.Cell class="font-mono text-xs">{job.id}</Table.Cell><Table.Cell
                    >{job.segmentIndex}</Table.Cell
                  ><Table.Cell>{job.ownerNodeId ?? 'Unassigned'}</Table.Cell><Table.Cell
                    ><StatusBadge value={job.state} /></Table.Cell
                  ><Table.Cell
                    ><div class="flex justify-end gap-2">
                      {#if job.state === 'failed' || job.state === 'cancelled'}<Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === job.id}
                          onclick={() => retryJob(job)}
                          ><RotateCcw data-icon="inline-start" />Retry</Button
                        >{:else if job.state !== 'complete'}<Button
                          variant="destructive"
                          size="sm"
                          disabled={busyId === job.id}
                          onclick={() => cancelJob(job)}
                          ><Square data-icon="inline-start" />Cancel</Button
                        >{/if}<Button variant="ghost" size="sm" onclick={() => showJobLogs(job)}
                        >Logs</Button
                      >
                    </div></Table.Cell
                  ></Table.Row
                >{/each}</Table.Body
            ></Table.Root
          >
        </div></Tabs.Content
      >

      <Tabs.Content value="bindings"
        ><div class="mb-3 flex justify-end">
          <Button
            variant="outline"
            onclick={() => {
              bindNodeId = sourceWorkers[0]?.id ?? '';
              bindOpen = true;
            }}><KeyRound data-icon="inline-start" />Bind provider</Button
          >
        </div>
        <div class="hidden overflow-hidden rounded-xl border md:block">
          <Table.Root
            ><Table.Header
              ><Table.Row
                ><Table.Head>Provider</Table.Head><Table.Head>Node</Table.Head><Table.Head
                  >Reachable</Table.Head
                ><Table.Head>Status</Table.Head><Table.Head>Validated</Table.Head></Table.Row
              ></Table.Header
            ><Table.Body
              >{#each bindings as binding}<Table.Row
                  ><Table.Cell class="font-mono text-xs">{binding.providerId}</Table.Cell
                  ><Table.Cell>{binding.nodeId}</Table.Cell><Table.Cell
                    >{binding.reachable ? 'Yes' : 'No'}</Table.Cell
                  ><Table.Cell><StatusBadge value={binding.state} /></Table.Cell><Table.Cell
                    >{binding.validatedAt
                      ? new Date(binding.validatedAt).toLocaleString()
                      : 'Never'}</Table.Cell
                  ></Table.Row
                >{/each}</Table.Body
            ></Table.Root
          >
        </div>
        <div class="grid gap-3 md:hidden">
          {#each bindings as binding}<Card.Root
              ><Card.Header
                ><Card.Title>{binding.providerId}</Card.Title><Card.Description
                  >{nodes.find((node) => node.id === binding.nodeId)?.name ??
                    binding.nodeId}</Card.Description
                ><Card.Action><StatusBadge value={binding.state} /></Card.Action></Card.Header
              ></Card.Root
            >{/each}
        </div></Tabs.Content
      >

      <Tabs.Content value="cache"
        ><div class="mb-3 flex flex-wrap justify-end gap-2">
          <Select.Root
            type="single"
            value={cacheTargetId}
            onValueChange={(value) => {
              cacheTargetId = value ?? '__local__';
              void loadCache(cacheTargetId);
            }}
          >
            <Select.Trigger aria-label="Cache target">{cacheTargetLabel}</Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value="__local__">Local cache</Select.Item>
                {#each cacheNodes as node}<Select.Item value={node.id}>{node.name}</Select.Item
                  >{/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
          <Button variant="outline" disabled={cacheLoading} onclick={() => loadCache()}>
            <RefreshCw data-icon="inline-start" />Refresh
          </Button>
          <Button
            variant="destructive"
            disabled={!cache.length || busyId === 'cache'}
            onclick={() => evictAll()}
          >
            <Trash2 data-icon="inline-start" />Evict all
          </Button>
        </div>
        <div class="hidden overflow-hidden rounded-xl border md:block">
          <Table.Root
            ><Table.Header
              ><Table.Row
                ><Table.Head>Key</Table.Head><Table.Head>Type</Table.Head><Table.Head
                  >Size</Table.Head
                ><Table.Head>Expires</Table.Head></Table.Row
              ></Table.Header
            ><Table.Body
              >{#each cache as object}<Table.Row
                  ><Table.Cell class="max-w-md truncate font-mono text-xs">{object.key}</Table.Cell
                  ><Table.Cell>{object.contentType}</Table.Cell><Table.Cell
                    >{(object.size / 1024).toFixed(1)} KB</Table.Cell
                  ><Table.Cell
                    >{object.expiresAt
                      ? new Date(object.expiresAt).toLocaleString()
                      : 'Never'}</Table.Cell
                  ></Table.Row
                >{/each}</Table.Body
            ></Table.Root
          >
        </div>
        <div class="grid gap-3 md:hidden">
          {#each cache as object}<Card.Root
              ><Card.Header
                ><Card.Title class="truncate font-mono text-sm">{object.key}</Card.Title
                ><Card.Description
                  >{(object.size / 1024).toFixed(1)} KB · {object.contentType}</Card.Description
                ></Card.Header
              ></Card.Root
            >{/each}
        </div></Tabs.Content
      >
    </Tabs.Root>
  {/if}
</div>

<Dialog.Root bind:open={enrollOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Enroll a cluster node</Dialog.Title>
      <Dialog.Description>
        Create a single-use, ten-minute token. The node receives its own rotating certificate.
      </Dialog.Description>
    </Dialog.Header>
    {#if joinResult}
      <Card.Root>
        <Card.Content class="flex flex-col gap-3 pt-6">
          <code class="break-all text-sm">{joinResult.token}</code>
          <Button variant="outline" onclick={() => copy(joinResult!.token)}>
            <Copy data-icon="inline-start" />Copy token
          </Button>
          <p class="text-muted-foreground text-sm">
            Expires {new Date(joinResult.expiresAt).toLocaleString()}.
          </p>
        </Card.Content>
      </Card.Root>
    {:else}
      <Field.Group>
        <Field.Field>
          <Field.Label for="cluster-node-name">Node name</Field.Label>
          <Input id="cluster-node-name" bind:value={nodeName} />
        </Field.Field>
        <Field.Field>
          <Field.Label for="cluster-node-region">Region</Field.Label>
          <Input id="cluster-node-region" bind:value={region} />
        </Field.Field>
        <Field.Field>
          <Field.Label for="cluster-node-role">Role</Field.Label>
          <Select.Root type="single" bind:value={nodeRole}>
            <Select.Trigger id="cluster-node-role" class="w-full">{nodeRole}</Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value="source-worker">Source worker</Select.Item>
                <Select.Item value="ingest-origin">Ingest origin</Select.Item>
                <Select.Item value="edge">Edge</Select.Item>
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </Field.Field>
      </Field.Group>
    {/if}
    <Dialog.Footer>
      {#if joinResult}
        <Button onclick={() => (enrollOpen = false)}>Done</Button>
      {:else}
        <Button disabled={!nodeName || !region} onclick={() => createJoinToken()}
          >Create token</Button
        >
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={bindOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Bind Jellyfin to a source worker</Dialog.Title>
      <Dialog.Description>
        The password crosses the authenticated node channel once and is discarded after the worker
        stores its token.
      </Dialog.Description>
    </Dialog.Header>
    <Field.Group>
      <Field.Field>
        <Field.Label for="binding-provider">Provider</Field.Label>
        <Select.Root type="single" bind:value={bindProviderId}>
          <Select.Trigger id="binding-provider" class="w-full">
            {bindProviderId === 'new'
              ? 'Create a new provider'
              : (providers.find((provider) => provider.id === bindProviderId)?.name ??
                'Select provider')}
          </Select.Trigger>
          <Select.Content>
            <Select.Group>
              <Select.Item value="new">Create a new provider</Select.Item>
              {#each providers as provider}<Select.Item value={provider.id}
                  >{provider.name} · failover binding</Select.Item
                >{/each}
            </Select.Group>
          </Select.Content>
        </Select.Root>
      </Field.Field>
      <Field.Field>
        <Field.Label for="binding-worker">Source worker</Field.Label>
        <Select.Root type="single" bind:value={bindNodeId}>
          <Select.Trigger id="binding-worker" class="w-full">
            {sourceWorkers.find((node) => node.id === bindNodeId)?.name ?? 'Select worker'}
          </Select.Trigger>
          <Select.Content>
            <Select.Group>
              {#each sourceWorkers as node}<Select.Item value={node.id}
                  >{node.name} · {node.region}</Select.Item
                >{/each}
            </Select.Group>
          </Select.Content>
        </Select.Root>
      </Field.Field>
      <Field.Field>
        <Field.Label for="binding-name">Name</Field.Label>
        <Input id="binding-name" bind:value={bindName} />
      </Field.Field>
      <Field.Field>
        <Field.Label for="binding-url">Jellyfin URL</Field.Label>
        <Input id="binding-url" bind:value={bindUrl} placeholder="https://jellyfin.example.com" />
      </Field.Field>
      <Field.Field>
        <Field.Label for="binding-username">Username</Field.Label>
        <Input id="binding-username" bind:value={bindUsername} autocomplete="username" />
      </Field.Field>
      <Field.Field>
        <Field.Label for="binding-password">Password</Field.Label>
        <Input
          id="binding-password"
          type="password"
          bind:value={bindPassword}
          autocomplete="current-password"
        />
      </Field.Field>
    </Field.Group>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (bindOpen = false)}>Cancel</Button>
      <Button
        disabled={!bindNodeId || !bindUrl || !bindUsername || !bindPassword}
        onclick={() => createBinding()}>Store on worker</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={backendOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Configure traffic director</Dialog.Title>
      <Dialog.Description>
        Choose built-in routing, a static edge or region, or an authenticated routing webhook.
      </Dialog.Description>
    </Dialog.Header>
    <Field.Group>
      <Field.Field>
        <Field.Label for="routing-kind">Routing backend</Field.Label>
        <Select.Root type="single" bind:value={routingKind}>
          <Select.Trigger id="routing-kind" class="w-full">{routingKind}</Select.Trigger>
          <Select.Content>
            <Select.Group>
              <Select.Item value="builtin">Built-in director</Select.Item>
              <Select.Item value="static">Static edge or region</Select.Item>
              <Select.Item value="webhook">Routing webhook</Select.Item>
            </Select.Group>
          </Select.Content>
        </Select.Root>
      </Field.Field>
      {#if routingKind === 'static'}
        <Field.Field>
          <Field.Label for="routing-node">Static edge node ID</Field.Label>
          <Input
            id="routing-node"
            bind:value={routingNodeId}
            placeholder={edgeNodes[0]?.id ?? 'edge-node-id'}
          />
        </Field.Field>
        <Field.Field>
          <Field.Label for="routing-region">Optional region</Field.Label>
          <Input
            id="routing-region"
            bind:value={routingRegion}
            placeholder={edgeNodes[0]?.region ?? 'eu-west'}
          />
        </Field.Field>
      {:else if routingKind === 'webhook'}
        <Field.Field>
          <Field.Label for="routing-endpoint">Webhook endpoint</Field.Label>
          <Input
            id="routing-endpoint"
            bind:value={routingEndpoint}
            placeholder="https://director.example.com/route"
          />
        </Field.Field>
        <Field.Field>
          <Field.Label for="routing-secret">Optional secret reference</Field.Label>
          <Input
            id="routing-secret"
            bind:value={routingSecretRef}
            placeholder="routing/webhook-token"
          />
        </Field.Field>
      {/if}
      {#if backendResult}<Field.Description>
          {backendResult.healthy ? 'Validated' : 'Unavailable'} · {backendResult.message ??
            backendResult.kind}
        </Field.Description>{/if}
    </Field.Group>
    <Dialog.Footer>
      <Button variant="outline" disabled={backendBusy} onclick={() => validateRouting()}
        >Validate</Button
      >
      <Button
        disabled={backendBusy ||
          (routingKind === 'webhook' && !routingEndpoint) ||
          (routingKind === 'static' && !routingNodeId && !routingRegion)}
        onclick={() => activateRouting()}>Activate</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={storageOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Configure object storage</Dialog.Title>
      <Dialog.Description>
        Validate and stage one temporary segment store for every cluster role.
      </Dialog.Description>
    </Dialog.Header>
    <Field.Group>
      <Field.Field>
        <Field.Label for="storage-kind">Backend</Field.Label>
        <Select.Root type="single" bind:value={storageKind}>
          <Select.Trigger id="storage-kind" class="w-full">{storageKind}</Select.Trigger>
          <Select.Content>
            <Select.Group>
              <Select.Item value="local">Local filesystem</Select.Item>
              <Select.Item value="s3">S3 compatible</Select.Item>
              <Select.Item value="azure-blob">Azure Blob</Select.Item>
              <Select.Item value="gcs">Google Cloud Storage</Select.Item>
            </Select.Group>
          </Select.Content>
        </Select.Root>
      </Field.Field>
      {#if storageKind === 's3'}
        <Field.Field
          ><Field.Label for="storage-bucket">Bucket</Field.Label><Input
            id="storage-bucket"
            bind:value={storageBucket}
          /></Field.Field
        >
        <Field.Field
          ><Field.Label for="storage-endpoint">Optional endpoint</Field.Label><Input
            id="storage-endpoint"
            bind:value={storageEndpoint}
            placeholder="https://s3.example.com"
          /></Field.Field
        >
        <Field.Field
          ><Field.Label for="storage-region">Region</Field.Label><Input
            id="storage-region"
            bind:value={storageRegion}
            placeholder="us-east-1"
          /></Field.Field
        >
        <Field.Field orientation="horizontal">
          <Field.Content
            ><Field.Title>Force path-style requests</Field.Title><Field.Description
              >Recommended for MinIO.</Field.Description
            ></Field.Content
          >
          <Switch bind:checked={storageForcePathStyle} aria-label="Force path-style requests" />
        </Field.Field>
      {:else if storageKind === 'azure-blob'}
        <Field.Field
          ><Field.Label for="storage-account">Account URL</Field.Label><Input
            id="storage-account"
            bind:value={storageEndpoint}
            placeholder="https://account.blob.core.windows.net"
          /></Field.Field
        >
        <Field.Field
          ><Field.Label for="storage-container">Container</Field.Label><Input
            id="storage-container"
            bind:value={storageContainer}
          /></Field.Field
        >
      {:else if storageKind === 'gcs'}
        <Field.Field
          ><Field.Label for="storage-gcs-bucket">Bucket</Field.Label><Input
            id="storage-gcs-bucket"
            bind:value={storageBucket}
          /></Field.Field
        >
        <Field.Field
          ><Field.Label for="storage-project">Project ID</Field.Label><Input
            id="storage-project"
            bind:value={storageProjectId}
          /></Field.Field
        >
      {/if}
      {#if storageKind !== 'local'}
        <Field.Field
          ><Field.Label for="storage-prefix">Object prefix</Field.Label><Input
            id="storage-prefix"
            bind:value={storagePrefix}
          /></Field.Field
        >
        <Field.Field
          ><Field.Label for="storage-secret">Optional secret reference</Field.Label><Input
            id="storage-secret"
            bind:value={storageSecretRef}
            placeholder="object-store/credentials"
          /></Field.Field
        >
      {/if}
      {#if storageResult}<Field.Description>
          {storageResult.healthy ? 'Validated' : 'Unavailable'} · {storageResult.message ??
            storageResult.kind}
        </Field.Description>{/if}
    </Field.Group>
    <Dialog.Footer>
      <Button
        variant="outline"
        disabled={storageBusy || !storageReady()}
        onclick={() => validateStorage()}>Validate</Button
      >
      <Button disabled={storageBusy || !storageReady()} onclick={() => activateStorage()}
        >Stage and require restart</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={logsOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Node logs</Dialog.Title>
      <Dialog.Description
        >Bounded, structured and secret-redacted agent messages.</Dialog.Description
      >
    </Dialog.Header>
    <ScrollArea.Root class="max-h-96">
      <div class="flex flex-col gap-2 pr-4">
        {#each nodeLogs as log}<div class="flex items-start gap-3">
            <Badge variant="secondary">{log.level}</Badge>
            <div class="min-w-0">
              <p class="break-words text-sm">{log.message}</p>
              <p class="text-muted-foreground text-xs">
                {new Date(log.timestamp).toLocaleString()}
              </p>
            </div>
          </div>{:else}<p class="text-muted-foreground text-sm">
            No agent logs have been recorded.
          </p>{/each}
      </div>
    </ScrollArea.Root>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={jobLogsOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{jobLogsTitle}</Dialog.Title>
      <Dialog.Description
        >Bounded, structured and secret-redacted segment job messages.</Dialog.Description
      >
    </Dialog.Header>
    <ScrollArea.Root class="max-h-96">
      <div class="flex flex-col gap-2 pr-4">
        {#each jobLogs as log}<div class="flex items-start gap-3">
            <Badge variant="secondary">{log.level}</Badge>
            <div class="min-w-0">
              <p class="break-words text-sm">{log.message}</p>
              <p class="text-muted-foreground text-xs">
                {new Date(log.timestamp).toLocaleString()}
              </p>
            </div>
          </div>{:else}<p class="text-muted-foreground text-sm">
            No job logs have been recorded.
          </p>{/each}
      </div>
    </ScrollArea.Root>
  </Dialog.Content>
</Dialog.Root>
