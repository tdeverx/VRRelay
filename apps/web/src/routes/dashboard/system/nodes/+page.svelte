<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Copy, Plus, RefreshCw, ScrollText, ShieldX, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { AgentLogEntry, ClusterNode } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import { loginRoute } from '#lib/new-ui/state.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import ConfirmAction from '#lib/new-ui/components/ConfirmAction.svelte';
  import { Badge } from '#lib/new-ui/components/ui/badge';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Dialog from '#lib/new-ui/components/ui/dialog';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as ScrollArea from '#lib/new-ui/components/ui/scroll-area';
  import * as Select from '#lib/new-ui/components/ui/select';
  import * as Table from '#lib/new-ui/components/ui/table';

  type NodeWithAgent = ClusterNode & { agent: { connected: boolean; connectedAt?: string } };

  let nodes = $state<NodeWithAgent[]>([]);
  let loading = $state(true);
  let error = $state('');
  let busyId = $state('');
  let enrollOpen = $state(false);
  let nodeName = $state('New edge');
  let region = $state('local');
  let nodeRole = $state<'source-worker' | 'ingest-origin' | 'edge'>('edge');
  let joinResult = $state<{ token: string; expiresAt: string } | null>(null);
  let nodeLogs = $state<AgentLogEntry[]>([]);
  let logsOpen = $state(false);
  let pendingRevoke = $state<ClusterNode | null>(null);
  let pendingRemove = $state<ClusterNode | null>(null);

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      nodes = (await api.clusterNodes()).items;
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(loginRoute(page.url.pathname));
      error = reason instanceof Error ? reason.message : 'Could not load nodes.';
    } finally {
      loading = false;
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
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied to clipboard.');
    } catch {
      toast.error('Clipboard access was denied. Select and copy the value manually.');
    }
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
    } finally {
      busyId = '';
    }
  }

  async function remove(node: ClusterNode) {
    busyId = node.id;
    try {
      await api.removeNode(node.id);
      nodes = nodes.filter((candidate) => candidate.id !== node.id);
      toast.success('Revoked node record removed.');
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
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader title="Nodes" description="Enrollment, worker state, certificates and agent logs.">
    {#snippet actions()}
      <Button variant="outline" disabled={loading} onclick={load}>
        <RefreshCw data-icon="inline-start" />Refresh
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
  <LoadState {loading} {error} label="nodes" variant="metrics" />
  {#if !loading && !error}
    <section class="grid gap-4 sm:grid-cols-3" aria-label="Node summary">
      {#each [{ label: 'Nodes', value: nodes.length }, { label: 'Online', value: nodes.filter((node) => node.agent.connected).length }, { label: 'Worker capacity', value: `${nodes.reduce((total, node) => total + node.capabilities.activeWorkers, 0)} / ${nodes.reduce((total, node) => total + node.capabilities.maxWorkers, 0)}` }] as metric}
        <Card.Root>
          <Card.Header>
            <Card.Description>{metric.label}</Card.Description>
            <Card.Title>{metric.value}</Card.Title>
          </Card.Header>
        </Card.Root>
      {/each}
    </section>

    <div class="hidden overflow-hidden rounded-xl border md:block">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Node</Table.Head><Table.Head>Region</Table.Head><Table.Head
              >Roles</Table.Head
            ><Table.Head>Workers</Table.Head><Table.Head>Status</Table.Head><Table.Head
            ></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each nodes as node}
            <Table.Row>
              <Table.Cell class="font-medium">{node.name}</Table.Cell>
              <Table.Cell>{node.region}</Table.Cell>
              <Table.Cell>{node.roles.join(', ')}</Table.Cell>
              <Table.Cell
                >{node.capabilities.activeWorkers}/{node.capabilities.maxWorkers}</Table.Cell
              >
              <Table.Cell
                ><StatusBadge value={node.agent.connected ? node.state : 'offline'} /></Table.Cell
              >
              <Table.Cell>
                <div class="flex justify-end gap-2">
                  {#if node.state !== 'revoked'}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === node.id}
                      onclick={() => drain(node)}
                    >
                      {node.state === 'draining'
                        ? node.id === 'standalone'
                          ? 'Resume local worker'
                          : 'Cancel drain'
                        : 'Drain'}
                    </Button>
                  {/if}
                  {#if !node.roles.includes('controller')}
                    <Button variant="ghost" size="sm" onclick={() => showLogs(node)}
                      ><ScrollText />Logs</Button
                    >
                    {#if node.state === 'revoked'}
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busyId === node.id}
                        onclick={() => (pendingRemove = node)}><Trash2 />Remove</Button
                      >
                    {:else}
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
                        onclick={() => (pendingRevoke = node)}><ShieldX />Revoke</Button
                      >
                    {/if}
                  {/if}
                </div>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>

    <div class="grid gap-3 md:hidden">
      {#each nodes as node}
        <Card.Root>
          <Card.Header>
            <Card.Title>{node.name}</Card.Title>
            <Card.Description>{node.region} · {node.roles.join(', ')}</Card.Description>
            <Card.Action
              ><StatusBadge value={node.agent.connected ? node.state : 'offline'} /></Card.Action
            >
          </Card.Header>
          <Card.Footer class="flex flex-wrap gap-2">
            {#if node.state !== 'revoked'}
              <Button variant="outline" size="sm" onclick={() => drain(node)}>
                {node.state === 'draining'
                  ? node.id === 'standalone'
                    ? 'Resume local worker'
                    : 'Cancel drain'
                  : 'Drain node'}
              </Button>
            {/if}
            {#if !node.roles.includes('controller')}
              <Button variant="outline" size="sm" onclick={() => showLogs(node)}>Logs</Button>
              {#if node.state === 'revoked'}
                <Button variant="destructive" size="sm" onclick={() => (pendingRemove = node)}
                  >Remove</Button
                >
              {:else}
                <Button variant="outline" size="sm" onclick={() => rotate(node)}>Rotate</Button>
                <Button variant="destructive" size="sm" onclick={() => (pendingRevoke = node)}
                  >Revoke</Button
                >
              {/if}
            {/if}
          </Card.Footer>
        </Card.Root>
      {/each}
    </div>
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
          <Button variant="outline" onclick={() => copy(joinResult!.token)}
            ><Copy />Copy token</Button
          >
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
        <Button disabled={!nodeName || !region} onclick={createJoinToken}>Create token</Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmAction
  open={Boolean(pendingRevoke)}
  onOpenChange={(open) => !open && (pendingRevoke = null)}
  title="Revoke cluster node?"
  description={`Revoke ${pendingRevoke?.name ?? 'this node'} and invalidate its agent certificate. Work assigned to it may fail until rescheduled.`}
  confirmLabel="Revoke node"
  onConfirm={async () => {
    if (!pendingRevoke) return;
    await revoke(pendingRevoke);
    pendingRevoke = null;
  }}
/>

<ConfirmAction
  open={Boolean(pendingRemove)}
  onOpenChange={(open) => !open && (pendingRemove = null)}
  title="Remove revoked node record?"
  description={`Permanently remove ${pendingRemove?.name ?? 'this node'} from cluster state. Removal is refused while provider bindings remain.`}
  confirmLabel="Remove node"
  onConfirm={async () => {
    if (!pendingRemove) return;
    await remove(pendingRemove);
    pendingRemove = null;
  }}
/>

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
        {#each nodeLogs as log}
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
          <p class="text-muted-foreground text-sm">No agent logs have been recorded.</p>
        {/each}
      </div>
    </ScrollArea.Root>
  </Dialog.Content>
</Dialog.Root>
