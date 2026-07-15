<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    Activity,
    CircleDot,
    Cloud,
    Copy,
    Database,
    Gauge,
    KeyRound,
    Network,
    Plus,
    RefreshCw,
    Server,
    Settings2,
    Trash2
  } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type {
    AgentLogEntry,
    BackendStatus,
    CachedObject,
    ClusterNode,
    PublicProviderConnection,
    PublicProviderBinding,
    SegmentJob
  } from '@vrrelay/domain';
  import AppShell from '$lib/components/AppShell.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActivityRail from '$lib/components/ActivityRail.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Progress } from '$lib/components/ui/progress';
  import { Switch } from '$lib/components/ui/switch';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Table from '$lib/components/ui/table';
  import * as Select from '$lib/components/ui/select';

  let nodes = $state<Array<ClusterNode & { agent?: { connected: boolean; connectedAt?: string } }>>(
    []
  );
  let backends = $state<BackendStatus[]>([]);
  let jobs = $state<SegmentJob[]>([]);
  let events = $state<Awaited<ReturnType<typeof api.recentEvents>>['items']>([]);
  let loading = $state(true);
  let enrollOpen = $state(false);
  let nodeName = $state('New edge');
  let region = $state('local');
  let joinResult = $state<{ token: string; expiresAt: string } | null>(null);
  let nodeRole = $state<'source-worker' | 'ingest-origin' | 'edge'>('edge');
  let bindings = $state<PublicProviderBinding[]>([]);
  let providers = $state<PublicProviderConnection[]>([]);
  let cache = $state<CachedObject[]>([]);
  let cacheLoading = $state(false);
  let cacheTargetId = $state('__local__');
  let bindOpen = $state(false);
  let bindNodeId = $state('');
  let bindProviderId = $state('new');
  let bindName = $state('Jellyfin');
  let bindUrl = $state('');
  let bindUsername = $state('');
  let bindPassword = $state('');
  let nodeLogs = $state<AgentLogEntry[]>([]);
  let logsOpen = $state(false);
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

  const onlineNodes = $derived(nodes.filter((node) => node.state === 'online'));
  const edgeNodes = $derived(nodes.filter((node) => node.roles.includes('edge')));
  const cacheNodes = $derived(
    nodes.filter(
      (node) =>
        node.agent?.connected &&
        (node.roles.includes('edge') || node.roles.includes('source-worker'))
    )
  );
  const cacheTotalBytes = $derived(cache.reduce((sum, item) => sum + item.size, 0));
  const cacheTargetLabel = $derived(
    cacheTargetId === '__local__'
      ? 'Local cache'
      : (nodes.find((node) => node.id === cacheTargetId)?.name ?? cacheTargetId)
  );
  const activeWorkers = $derived(
    nodes.reduce((sum, node) => sum + node.capabilities.activeWorkers, 0)
  );
  const workerLimit = $derived(nodes.reduce((sum, node) => sum + node.capabilities.maxWorkers, 0));
  const runningJobs = $derived(
    jobs.filter(
      (job) => job.state === 'queued' || job.state === 'leased' || job.state === 'running'
    )
  );

  async function load() {
    loading = true;
    try {
      const [nodeResult, backendResult, jobResult, eventResult, bindingResult, providerResult] =
        await Promise.all([
          api.clusterNodes(),
          api.clusterBackends(),
          api.segmentJobs(),
          api.recentEvents(),
          api.providerBindings(),
          api.providers()
        ]);
      nodes = nodeResult.items;
      if (
        cacheTargetId !== '__local__' &&
        !nodeResult.items.some(
          (node) =>
            node.id === cacheTargetId &&
            node.agent?.connected &&
            (node.roles.includes('edge') || node.roles.includes('source-worker'))
        )
      )
        cacheTargetId = '__local__';
      backends = backendResult.items;
      jobs = jobResult.items;
      events = eventResult.items;
      bindings = bindingResult.items;
      providers = providerResult.items;
      await loadCache(cacheTargetId);
    } catch (error) {
      if (isAuthenticatedError(error)) return goto('/login');
      toast.error(error instanceof Error ? error.message : 'Could not load cluster state.');
    } finally {
      loading = false;
    }
  }

  async function loadCache(targetId = cacheTargetId) {
    cacheLoading = true;
    try {
      cache = (await api.cacheInventory(targetId === '__local__' ? undefined : targetId)).items;
    } catch (error) {
      if (isAuthenticatedError(error)) return goto('/login');
      toast.error(error instanceof Error ? error.message : 'Could not load cache inventory.');
    } finally {
      cacheLoading = false;
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

  function routingReady() {
    if (routingKind === 'webhook') return Boolean(routingEndpoint);
    if (routingKind === 'static') return Boolean(routingNodeId || routingRegion);
    return true;
  }

  async function validateRouting() {
    backendBusy = true;
    try {
      backendResult = await api.validateBackend(routingRequest());
      if (backendResult.healthy) toast.success('Routing backend is reachable.');
      else toast.error(backendResult.message ?? 'Routing backend validation failed.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not validate routing backend.');
    } finally {
      backendBusy = false;
    }
  }

  async function activateRouting() {
    backendBusy = true;
    try {
      backendResult = await api.activateBackend(routingRequest());
      await load();
      backendOpen = false;
      toast.success('Routing backend activated.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not activate routing backend.');
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
      if (storageResult.healthy) toast.success('Object store is reachable.');
      else toast.error(storageResult.message ?? 'Object-store validation failed.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not validate object store.');
    } finally {
      storageBusy = false;
    }
  }

  async function activateStorage() {
    storageBusy = true;
    try {
      storageResult = await api.activateBackend(storageRequest());
      await load();
      storageOpen = false;
      toast.success('Object store staged. Restart every relay role to activate it.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not stage object store.');
    } finally {
      storageBusy = false;
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create join token.');
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    toast.success('Copied to clipboard.');
  }

  async function toggleDrain(node: ClusterNode) {
    try {
      await api.drainNode(node.id, node.state !== 'draining');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update node.');
    }
  }

  async function rotate(node: ClusterNode) {
    try {
      await api.rotateNodeCertificate(node.id);
      toast.success('Node certificate rotated.');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not rotate certificate.');
    }
  }

  async function revoke(node: ClusterNode) {
    if (!confirm(`Revoke ${node.name} and disconnect it immediately?`)) return;
    try {
      await api.revokeNode(node.id);
      toast.success('Node revoked.');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revoke node.');
    }
  }

  async function showLogs(node: ClusterNode) {
    try {
      nodeLogs = (await api.nodeLogs(node.id)).items;
      logsOpen = true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load node logs.');
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
      toast.success('Provider credentials stored on the selected worker.');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not bind provider.');
    }
  }

  async function evictAll() {
    const target = cacheTargetLabel;
    if (
      !confirm(
        `Evict every temporary cache object on ${target}? Sessions and playback links are retained.`
      )
    )
      return;
    try {
      const result = await api.evictCache({
        all: true,
        ...(cacheTargetId === '__local__' ? {} : { nodeId: cacheTargetId })
      });
      toast.success(`Evicted ${result.removed} objects.`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not evict cache.');
    }
  }

  async function cancelJob(job: SegmentJob) {
    try {
      await api.cancelSegmentJob(job.id);
      toast.success('Segment job cancelled.');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not cancel the segment job.');
    }
  }

  async function retryJob(job: SegmentJob) {
    try {
      toast.info('Retrying the segment job…');
      await api.retrySegmentJob(job.id);
      toast.success('Segment job completed.');
      await load();
    } catch (error) {
      await load();
      toast.error(error instanceof Error ? error.message : 'Could not retry the segment job.');
    }
  }

  onMount(() => {
    void load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  });
</script>

<AppShell active="cluster">
  {#snippet rail()}<ActivityRail {events} />{/snippet}
  <div class="page">
    <PageHeader
      title="Cluster topology"
      description="Provider-neutral workers, ingest origins, and viewer-facing edges."
    >
      {#snippet actions()}
        <Button variant="outline" size="sm" disabled={loading} onclick={() => void load()}
          ><span class:spin={loading}><RefreshCw /></span>Refresh</Button
        >
        <Button
          variant="outline"
          size="sm"
          onclick={() => {
            bindNodeId =
              nodes.find((node) => node.roles.includes('source-worker') && node.agent?.connected)
                ?.id ?? '';
            bindOpen = true;
          }}><KeyRound />Bind provider</Button
        >
        <Button
          size="sm"
          onclick={() => {
            joinResult = null;
            enrollOpen = true;
          }}><Plus />Enroll node</Button
        >
      {/snippet}
    </PageHeader>

    <div class="summary-grid">
      <article>
        <Network />
        <div><strong>{onlineNodes.length} / {nodes.length}</strong><span>Healthy nodes</span></div>
        <Badge variant={onlineNodes.length === nodes.length ? 'success' : 'neutral'}
          >{onlineNodes.length === nodes.length ? 'Healthy' : 'Attention'}</Badge
        >
      </article>
      <article>
        <Server />
        <div><strong>{edgeNodes.length}</strong><span>Available edges</span></div>
        <small>{new Set(edgeNodes.map((node) => node.region)).size} regions</small>
      </article>
      <article>
        <Gauge />
        <div><strong>{activeWorkers} / {workerLimit}</strong><span>Encoder workers</span></div>
        <Progress value={workerLimit ? (activeWorkers / workerLimit) * 100 : 0} />
      </article>
      <article>
        <Activity />
        <div><strong>{runningJobs.length}</strong><span>Active segment jobs</span></div>
        <small>{jobs.length} recent</small>
      </article>
    </div>

    <section class="topology">
      <div class="section-heading">
        <div>
          <h2>Nodes</h2>
          <p>Explicit roles may be combined on the same runtime.</p>
        </div>
        <Badge variant="outline">Centralized, not P2P</Badge>
      </div>
      <div class="table-frame">
        <Table.Root>
          <Table.Header
            ><Table.Row
              ><Table.Head>Node</Table.Head><Table.Head>Roles</Table.Head><Table.Head
                >Region</Table.Head
              ><Table.Head>Capacity</Table.Head><Table.Head>Cache / egress</Table.Head><Table.Head
                >Status</Table.Head
              ><Table.Head>Certificate</Table.Head><Table.Head></Table.Head></Table.Row
            ></Table.Header
          >
          <Table.Body>
            {#each nodes as node}
              <Table.Row>
                <Table.Cell
                  ><div class="node-name">
                    <span class:warning={node.state !== 'online'}></span>
                    <div><strong>{node.name}</strong><code>{node.id}</code></div>
                  </div></Table.Cell
                >
                <Table.Cell
                  ><div class="role-list">
                    {#each node.roles as role}<Badge variant="neutral">{role}</Badge>{/each}
                  </div></Table.Cell
                >
                <Table.Cell>{node.region}</Table.Cell>
                <Table.Cell
                  ><strong>{node.capabilities.activeWorkers}/{node.capabilities.maxWorkers}</strong
                  ><small>encoders</small></Table.Cell
                >
                <Table.Cell
                  ><strong>{(node.capabilities.cacheBytes / 1_073_741_824).toFixed(1)} GB</strong
                  ><small>{node.capabilities.egressMbps.toFixed(1)} Mbps</small></Table.Cell
                >
                <Table.Cell
                  ><Badge
                    variant={node.state === 'online' &&
                    (node.roles.includes('controller') || node.agent?.connected)
                      ? 'success'
                      : 'neutral'}
                    >{node.roles.includes('controller')
                      ? node.state
                      : node.agent?.connected
                        ? 'connected'
                        : node.state}</Badge
                  ><small>{new Date(node.lastHeartbeatAt).toLocaleTimeString()}</small></Table.Cell
                >
                <Table.Cell
                  ><strong
                    >{node.certificateExpiresAt
                      ? new Date(node.certificateExpiresAt).toLocaleDateString()
                      : 'Local'}</strong
                  ><small
                    >{node.certificateExpiresAt ? 'rotating mTLS' : 'controller identity'}</small
                  ></Table.Cell
                >
                <Table.Cell
                  ><div class="node-actions">
                    <Button variant="ghost" size="sm" onclick={() => void toggleDrain(node)}
                      >{node.state === 'draining' ? 'Resume' : 'Drain'}</Button
                    >{#if !node.roles.includes('controller')}<Button
                        variant="ghost"
                        size="sm"
                        onclick={() => void showLogs(node)}>Logs</Button
                      ><Button variant="ghost" size="sm" onclick={() => void rotate(node)}
                        >Rotate</Button
                      ><Button variant="ghost" size="sm" onclick={() => void revoke(node)}
                        >Revoke</Button
                      >{/if}
                  </div></Table.Cell
                >
              </Table.Row>
            {:else}
              <Table.Row><Table.Cell colspan={8}>No nodes are enrolled.</Table.Cell></Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    </section>

    <div class="lower-grid">
      <section>
        <div class="section-heading">
          <div>
            <h2>Infrastructure backends</h2>
            <p>Selected through application ports, never vendor domain types.</p>
          </div>
          <div class="backend-actions">
            <Button variant="outline" size="sm" onclick={() => (storageOpen = true)}
              ><Cloud />Configure storage</Button
            ><Button variant="outline" size="sm" onclick={() => (backendOpen = true)}
              ><Settings2 />Configure routing</Button
            >
          </div>
        </div>
        <div class="backend-list">
          {#each backends as backend}
            <article>
              {#if backend.kind.includes('object') || backend.kind.includes('s3')}<Cloud
                />{:else}<Database />{/if}
              <div>
                <strong>{backend.category} · {backend.kind}</strong><span
                  >{backend.message ?? 'Connected'}</span
                >
              </div>
              <Badge variant={backend.healthy ? 'success' : 'neutral'}
                >{backend.restartRequired
                  ? 'Restart required'
                  : backend.healthy
                    ? 'Healthy'
                    : 'Unavailable'}</Badge
              >
            </article>
          {/each}
        </div>
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2>Segment jobs</h2>
            <p>Cluster-wide cache misses and encoder leases.</p>
          </div>
        </div>
        <div class="job-list">
          {#each jobs.slice(0, 7) as job}
            <article>
              <CircleDot />
              <div>
                <strong>Segment {job.segmentIndex} · {job.contentKey.slice(0, 12)}</strong><span
                  >{job.ownerNodeId ?? 'Awaiting placement'} · {job.state} · {job.workerHistory
                    .length}
                  worker attempt{job.workerHistory.length === 1 ? '' : 's'}</span
                >
              </div>
              <div class="job-actions">
                <time>{new Date(job.updatedAt).toLocaleTimeString()}</time>
                {#if job.state === 'failed' || job.state === 'cancelled'}<Button
                    variant="ghost"
                    size="sm"
                    onclick={() => void retryJob(job)}>Retry</Button
                  >{:else if job.state === 'queued' || job.state === 'leased' || job.state === 'running'}<Button
                    variant="ghost"
                    size="sm"
                    onclick={() => void cancelJob(job)}>Cancel</Button
                  >{/if}
              </div>
            </article>
          {:else}<div class="empty">No segment work has been requested yet.</div>{/each}
        </div>
      </section>
    </div>

    <div class="lower-grid operations">
      <section>
        <div class="section-heading">
          <div>
            <h2>Provider bindings</h2>
            <p>Secrets remain on explicitly selected source workers.</p>
          </div>
          <Badge variant="outline">{bindings.length} bindings</Badge>
        </div>
        <div class="job-list">
          {#each bindings as binding}<article>
              <KeyRound />
              <div>
                <strong>{binding.providerId}</strong><span
                  >{nodes.find((node) => node.id === binding.nodeId)?.name ?? binding.nodeId} · {binding.state}</span
                >
              </div>
              <Badge variant={binding.state === 'healthy' ? 'success' : 'neutral'}
                >{binding.reachable ? 'Reachable' : 'Unavailable'}</Badge
              >
            </article>{:else}<div class="empty">No node-local provider bindings yet.</div>{/each}
        </div>
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2>Node cache</h2>
            <p>Temporary source and edge objects only; sessions and links are retained.</p>
          </div>
          <div class="cache-actions">
            <div class="cache-select">
              <Select.Root
                type="single"
                bind:value={cacheTargetId}
                onValueChange={(value) => {
                  cacheTargetId = value ?? '__local__';
                  void loadCache(cacheTargetId);
                }}
              >
                <Select.Trigger>{cacheTargetLabel}</Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    <Select.Item value="__local__" label="Local cache">Local cache</Select.Item>
                    {#each cacheNodes as node}
                      <Select.Item value={node.id} label={node.name}
                        >{node.name} · {node.roles.join(', ')}</Select.Item
                      >
                    {/each}
                  </Select.Group>
                </Select.Content>
              </Select.Root>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={cacheLoading}
              onclick={() => void loadCache()}
              ><span class:spin={cacheLoading}><RefreshCw /></span>Refresh</Button
            >
            <Button
              variant="outline"
              size="sm"
              disabled={!cache.length || cacheLoading}
              onclick={() => void evictAll()}><Trash2 />Evict all</Button
            >
          </div>
        </div>
        <div class="backend-list">
          <article>
            <Database />
            <div>
              <strong>{cache.length} cached objects</strong><span
                >{(cacheTotalBytes / 1_073_741_824).toFixed(2)} GB on {cacheTargetLabel}</span
              >
            </div>
            <Badge variant="neutral">LRU + TTL</Badge>
          </article>
        </div>
      </section>
    </div>
  </div>
</AppShell>

<Dialog.Root bind:open={enrollOpen}>
  <Dialog.Content>
    <Dialog.Header
      ><Dialog.Title>Enroll an edge node</Dialog.Title><Dialog.Description
        >Create a single-use, ten-minute token. The new node receives its own rotating certificate.</Dialog.Description
      ></Dialog.Header
    >
    {#if joinResult}
      <div class="token-box">
        <code>{joinResult.token}</code><Button
          variant="outline"
          size="sm"
          onclick={() => void copy(joinResult!.token)}><Copy />Copy</Button
        >
      </div>
      <p class="hint">
        Expires {new Date(joinResult.expiresAt).toLocaleString()}. The token is consumed on first
        successful enrollment.
      </p>
    {:else}
      <label><span>Node name</span><Input bind:value={nodeName} /></label>
      <label><span>Region</span><Input bind:value={region} /></label>
      <label
        ><span>Role</span><Select.Root type="single" bind:value={nodeRole}
          ><Select.Trigger class="w-full">{nodeRole}</Select.Trigger><Select.Content
            ><Select.Group
              ><Select.Item value="source-worker" label="Source worker">Source worker</Select.Item
              ><Select.Item value="ingest-origin" label="Ingest origin">Ingest origin</Select.Item
              ><Select.Item value="edge" label="Edge">Edge</Select.Item></Select.Group
            ></Select.Content
          ></Select.Root
        ></label
      >
    {/if}
    <Dialog.Footer
      >{#if !joinResult}<Button onclick={() => void createJoinToken()}>Create token</Button
        >{:else}<Button onclick={() => (enrollOpen = false)}>Done</Button>{/if}</Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={backendOpen}>
  <Dialog.Content>
    <Dialog.Header
      ><Dialog.Title>Configure traffic director</Dialog.Title><Dialog.Description
        >Choose built-in capacity-aware hashing, a static edge or region target, or an authenticated
        provider-neutral routing webhook. Secret values remain in the configured node-local secret
        backend.</Dialog.Description
      ></Dialog.Header
    >
    <label
      ><span>Routing backend</span><Select.Root type="single" bind:value={routingKind}
        ><Select.Trigger class="w-full"
          >{routingKind === 'builtin'
            ? 'Built-in director'
            : routingKind === 'static'
              ? 'Static edge or region'
              : 'Routing webhook'}</Select.Trigger
        ><Select.Content
          ><Select.Group
            ><Select.Item value="builtin" label="Built-in director">Built-in director</Select.Item
            ><Select.Item value="static" label="Static edge or region"
              >Static edge or region</Select.Item
            >
            ><Select.Item value="webhook" label="Routing webhook">Routing webhook</Select.Item
            ></Select.Group
          ></Select.Content
        ></Select.Root
      ></label
    >
    {#if routingKind === 'static'}
      <label
        ><span>Static edge node ID</span><Input
          bind:value={routingNodeId}
          placeholder={edgeNodes[0]?.id ?? 'edge-node-id'}
        /><small
          >When set, only this online edge can receive traffic and preferred-region mismatches fail
          closed.</small
        ></label
      >
      <label
        ><span>Optional region</span><Input
          bind:value={routingRegion}
          placeholder={edgeNodes[0]?.region ?? 'eu-west'}
        /><small
          >Without a node ID, the director chooses an online edge from this region before falling
          back.</small
        ></label
      >
    {:else if routingKind === 'webhook'}
      <label
        ><span>HTTPS or private-network endpoint</span><Input
          bind:value={routingEndpoint}
          placeholder="https://director.example.com/route"
        /></label
      >
      <label
        ><span>Optional secret reference</span><Input
          bind:value={routingSecretRef}
          placeholder="routing/webhook-token"
        /><small>The referenced bearer token is never returned by the API.</small></label
      >
    {/if}
    {#if backendResult}
      <p class:backend-success={backendResult.healthy} class="backend-result">
        {backendResult.healthy ? 'Validated' : 'Unavailable'} · {backendResult.message ??
          backendResult.kind}
      </p>
    {/if}
    <Dialog.Footer
      ><Button variant="outline" disabled={backendBusy} onclick={() => void validateRouting()}
        >Validate</Button
      ><Button disabled={backendBusy || !routingReady()} onclick={() => void activateRouting()}
        >Activate</Button
      ></Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={storageOpen}>
  <Dialog.Content>
    <Dialog.Header
      ><Dialog.Title>Configure object storage</Dialog.Title><Dialog.Description
        >Validate and stage one temporary segment store for every cluster role. Credentials are read
        from a node-local secret reference and are never returned by the API.</Dialog.Description
      ></Dialog.Header
    >
    <label
      ><span>Backend</span><Select.Root type="single" bind:value={storageKind}
        ><Select.Trigger class="w-full">{storageKind}</Select.Trigger><Select.Content
          ><Select.Group
            ><Select.Item value="local" label="Local filesystem">Local filesystem</Select.Item
            ><Select.Item value="s3" label="S3 compatible">S3 compatible</Select.Item><Select.Item
              value="azure-blob"
              label="Azure Blob">Azure Blob</Select.Item
            ><Select.Item value="gcs" label="Google Cloud Storage">Google Cloud Storage</Select.Item
            ></Select.Group
          ></Select.Content
        ></Select.Root
      ></label
    >
    {#if storageKind === 's3'}
      <label><span>Bucket</span><Input bind:value={storageBucket} /></label>
      <label
        ><span>Optional endpoint</span><Input
          bind:value={storageEndpoint}
          placeholder="https://s3.example.com"
        /></label
      >
      <label><span>Region</span><Input bind:value={storageRegion} placeholder="us-east-1" /></label>
      <label class="switch-row"
        ><span><strong>Force path-style requests</strong><small>Recommended for MinIO.</small></span
        ><Switch bind:checked={storageForcePathStyle} /></label
      >
    {:else if storageKind === 'azure-blob'}
      <label
        ><span>Account URL</span><Input
          bind:value={storageEndpoint}
          placeholder="https://account.blob.core.windows.net"
        /></label
      >
      <label><span>Container</span><Input bind:value={storageContainer} /></label>
    {:else if storageKind === 'gcs'}
      <label><span>Bucket</span><Input bind:value={storageBucket} /></label>
      <label><span>Project ID</span><Input bind:value={storageProjectId} /></label>
    {/if}
    {#if storageKind !== 'local'}
      <label><span>Object prefix</span><Input bind:value={storagePrefix} /></label>
      <label
        ><span>Optional secret reference</span><Input
          bind:value={storageSecretRef}
          placeholder="object-store/credentials"
        /><small
          >S3 expects accessKeyId/secretAccessKey JSON; Azure expects accountName/accountKey; GCS
          expects client_email/private_key.</small
        ></label
      >
    {/if}
    {#if storageResult}
      <p class:backend-success={storageResult.healthy} class="backend-result">
        {storageResult.healthy ? 'Validated' : 'Unavailable'} · {storageResult.message ??
          storageResult.kind}
      </p>
    {/if}
    <p class="hint">Activation is cluster-wide after every relay role restarts.</p>
    <Dialog.Footer
      ><Button
        variant="outline"
        disabled={storageBusy || !storageReady()}
        onclick={() => void validateStorage()}>Validate</Button
      ><Button disabled={storageBusy || !storageReady()} onclick={() => void activateStorage()}
        >Stage and require restart</Button
      ></Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={bindOpen}>
  <Dialog.Content
    ><Dialog.Header
      ><Dialog.Title>Bind Jellyfin to a source worker</Dialog.Title><Dialog.Description
        >The password crosses the authenticated mTLS channel once and is discarded after the worker
        stores its user token.</Dialog.Description
      ></Dialog.Header
    >
    <label
      ><span>Provider</span><Select.Root type="single" bind:value={bindProviderId}
        ><Select.Trigger class="w-full"
          >{bindProviderId === 'new'
            ? 'Create a new provider'
            : (providers.find((provider) => provider.id === bindProviderId)?.name ??
              'Select provider')}</Select.Trigger
        ><Select.Content
          ><Select.Group
            ><Select.Item value="new" label="Create a new provider"
              >Create a new provider</Select.Item
            >{#each providers as provider}<Select.Item value={provider.id} label={provider.name}
                >{provider.name} · failover binding</Select.Item
              >{/each}</Select.Group
          ></Select.Content
        ></Select.Root
      ><small
        >Choose an existing provider to add its credentials explicitly to another worker.</small
      ></label
    >
    <label
      ><span>Source worker</span><Select.Root type="single" bind:value={bindNodeId}
        ><Select.Trigger class="w-full"
          >{nodes.find((node) => node.id === bindNodeId)?.name ?? 'Select worker'}</Select.Trigger
        ><Select.Content
          ><Select.Group
            >{#each nodes.filter((node) => node.roles.includes('source-worker') && node.agent?.connected) as node}<Select.Item
                value={node.id}
                label={node.name}>{node.name} · {node.region}</Select.Item
              >{/each}</Select.Group
          ></Select.Content
        ></Select.Root
      ></label
    >
    <label><span>Name</span><Input bind:value={bindName} /></label><label
      ><span>Jellyfin URL</span><Input
        bind:value={bindUrl}
        placeholder="https://jellyfin.example.com"
      /></label
    ><label><span>Username</span><Input bind:value={bindUsername} /></label><label
      ><span>Password</span><Input type="password" bind:value={bindPassword} /></label
    >
    <Dialog.Footer
      ><Button variant="outline" onclick={() => (bindOpen = false)}>Cancel</Button><Button
        disabled={!bindNodeId || !bindUrl || !bindUsername || !bindPassword}
        onclick={() => void createBinding()}>Store on worker</Button
      ></Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={logsOpen}
  ><Dialog.Content class="sm:max-w-2xl"
    ><Dialog.Header
      ><Dialog.Title>Node logs</Dialog.Title><Dialog.Description
        >Bounded, structured, and secret-redacted agent messages.</Dialog.Description
      ></Dialog.Header
    >
    <div class="log-list">
      {#each nodeLogs as log}<article>
          <time>{new Date(log.timestamp).toLocaleTimeString()}</time><Badge variant="neutral"
            >{log.level}</Badge
          ><span>{log.message}</span>
        </article>{:else}<div class="empty">No agent logs have been recorded.</div>{/each}
    </div>
    <Dialog.Footer><Button onclick={() => (logsOpen = false)}>Done</Button></Dialog.Footer
    ></Dialog.Content
  ></Dialog.Root
>

<style>
  .page {
    padding: 34px 38px 50px;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 26px;
  }
  .summary-grid article {
    display: grid;
    min-height: 92px;
    grid-template-columns: 34px 1fr;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    padding: 15px;
  }
  .summary-grid :global(svg) {
    grid-row: 1/3;
    width: 19px;
    color: var(--primary);
  }
  .summary-grid strong {
    font-size: 19px;
  }
  .summary-grid span,
  .summary-grid small {
    display: block;
    color: var(--muted-foreground);
    font-size: 10px;
  }
  .summary-grid :global([data-slot='badge']),
  .summary-grid :global([data-slot='progress']),
  .summary-grid > article > small {
    grid-column: 2;
    margin-top: 8px;
  }
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .section-heading h2 {
    font-size: 15px;
  }
  .section-heading p {
    margin-top: 3px;
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .backend-actions,
  .cache-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  .cache-select {
    min-width: 180px;
  }
  .table-frame {
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
  }
  .node-name {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .node-name > span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 9px color-mix(in oklab, var(--success) 45%, transparent);
  }
  .node-name > span.warning {
    background: var(--warning);
  }
  .node-name div {
    display: flex;
    flex-direction: column;
  }
  .node-name code {
    max-width: 150px;
    overflow: hidden;
    color: var(--muted-foreground);
    font-size: 9px;
    text-overflow: ellipsis;
  }
  .role-list,
  .node-actions {
    display: flex;
    max-width: 330px;
    flex-wrap: wrap;
    gap: 4px;
  }
  .table-frame small {
    display: block;
    margin-top: 3px;
    color: var(--muted-foreground);
    font-size: 9px;
  }
  .lower-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
    margin-top: 26px;
  }
  .operations {
    margin-top: 18px;
  }
  .backend-list,
  .job-list {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
  }
  .backend-list article,
  .job-list article {
    display: flex;
    min-height: 61px;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid var(--border);
    padding: 11px 14px;
  }
  .backend-list article:last-child,
  .job-list article:last-child {
    border-bottom: 0;
  }
  .backend-list :global(svg),
  .job-list :global(svg) {
    width: 18px;
    color: var(--primary);
  }
  .backend-list div,
  .job-list div {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 3px;
  }
  .job-list .job-actions {
    flex: 0 0 auto;
    align-items: flex-end;
  }
  .backend-list strong,
  .job-list strong {
    overflow: hidden;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .backend-list span,
  .job-list span,
  .job-list time,
  .hint {
    color: var(--muted-foreground);
    font-size: 9px;
  }
  .empty {
    padding: 28px;
    color: var(--muted-foreground);
    font-size: 11px;
    text-align: center;
  }
  .spin {
    animation: spin 1s linear infinite;
  }
  .token-box {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--muted);
    padding: 10px;
  }
  .token-box code {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    font-size: 10px;
    text-overflow: ellipsis;
  }
  .log-list {
    display: grid;
    max-height: 420px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .log-list article {
    display: grid;
    grid-template-columns: 70px 60px 1fr;
    gap: 10px;
    border-bottom: 1px solid var(--border);
    padding: 9px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
  }
  .log-list time {
    color: var(--muted-foreground);
  }
  label {
    display: grid;
    gap: 6px;
    margin: 12px 0;
  }
  label span {
    font-size: 11px;
  }
  label.switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  label.switch-row > span {
    display: grid;
    gap: 3px;
  }
  label.switch-row small,
  label > small {
    color: var(--muted-foreground);
    font-size: 9px;
  }
  .backend-result {
    margin: 12px 0;
    color: var(--destructive);
    font-size: 11px;
  }
  .backend-result.backend-success {
    color: var(--success);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 1050px) {
    .summary-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .lower-grid {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 650px) {
    .page {
      padding: 24px 16px;
    }
    .summary-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
