<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import type { BackendActivationRequest, BackendValidationRequest } from '@vrrelay/contracts';
  import { api } from '#lib/api';
  import ConfirmAction from '#lib/new-ui/components/ConfirmAction.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as Select from '#lib/new-ui/components/ui/select';
  import { Switch } from '#lib/new-ui/components/ui/switch';

  let backends = $state<Awaited<ReturnType<typeof api.clusterBackends>>['items']>([]);
  let loading = $state(true);
  let error = $state('');
  let category = $state<'object-store' | 'routing' | 'metrics'>('routing');
  let kind = $state('builtin');
  let endpoint = $state('');
  let secretRef = $state('');
  let nodeId = $state('');
  let bucket = $state('');
  let container = $state('');
  let region = $state('');
  let prefix = $state('');
  let projectId = $state('');
  let forcePathStyle = $state(false);
  let intervalSeconds = $state(30);
  let candidate = $state<Awaited<ReturnType<typeof api.validateBackend>> | null>(null);
  let validatedRequest = $state('');
  let busy = $state(false);
  let confirmActivation = $state(false);

  let kinds = $derived(
    category === 'object-store'
      ? ['local', 's3', 'azure-blob', 'gcs']
      : category === 'routing'
        ? ['builtin', 'static', 'webhook']
        : ['prometheus', 'webhook']
  );

  function chooseCategory(value: string | undefined) {
    if (value !== 'object-store' && value !== 'routing' && value !== 'metrics') return;
    category = value;
    kind = value === 'object-store' ? 'local' : value === 'routing' ? 'builtin' : 'prometheus';
    candidate = null;
    validatedRequest = '';
  }

  function request(): BackendValidationRequest {
    const objectStore = category === 'object-store';
    const webhook = kind === 'webhook';
    const staticRouting = category === 'routing' && kind === 'static';
    return {
      category,
      kind: kind as BackendValidationRequest['kind'],
      ...((webhook || (objectStore && ['s3', 'azure-blob'].includes(kind))) && endpoint.trim()
        ? { endpoint: endpoint.trim() }
        : {}),
      ...((webhook || (objectStore && kind !== 'local')) && secretRef.trim()
        ? { secretRef: secretRef.trim() }
        : {}),
      ...(staticRouting && nodeId.trim() ? { nodeId: nodeId.trim() } : {}),
      ...(objectStore && ['s3', 'gcs'].includes(kind) && bucket.trim()
        ? { bucket: bucket.trim() }
        : {}),
      ...(objectStore && kind === 'azure-blob' && container.trim()
        ? { container: container.trim() }
        : {}),
      ...((staticRouting || (objectStore && kind === 's3')) && region.trim()
        ? { region: region.trim() }
        : {}),
      ...(objectStore && kind !== 'local' && prefix.trim() ? { prefix: prefix.trim() } : {}),
      ...(objectStore && kind === 'gcs' && projectId.trim() ? { projectId: projectId.trim() } : {}),
      ...(objectStore && kind === 's3' ? { forcePathStyle } : {}),
      ...(category === 'metrics' && kind === 'webhook' ? { intervalSeconds } : {})
    };
  }

  function requestFingerprint(): string {
    return JSON.stringify(request());
  }

  async function loadBackends() {
    try {
      backends = (await api.clusterBackends()).items;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Could not load infrastructure services.';
    } finally {
      loading = false;
    }
  }

  async function validateCandidate() {
    busy = true;
    candidate = null;
    validatedRequest = '';
    try {
      const configuration = request();
      candidate = await api.validateBackend(configuration);
      validatedRequest = JSON.stringify(configuration);
      if (candidate.healthy) toast.success('Backend validation succeeded.');
      else toast.error(candidate.message ?? 'Backend validation failed.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Backend validation failed.');
    } finally {
      busy = false;
    }
  }

  async function activateCandidate() {
    const configuration = request() as BackendActivationRequest;
    if (!candidate?.healthy || validatedRequest !== JSON.stringify(configuration))
      throw new Error('Validate the unchanged backend configuration before activation.');
    const status = await api.activateBackend(configuration);
    candidate = status;
    validatedRequest = JSON.stringify(configuration);
    await loadBackends();
    toast.success(
      status.restartRequired
        ? 'Backend staged. Restart every relay role to finish activation.'
        : 'Backend activated.'
    );
  }

  onMount(loadBackends);
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

  <Card.Root>
    <Card.Header>
      <Card.Title>Validate and activate a backend</Card.Title>
      <Card.Description>
        Supply structured routing, metrics, or object-store settings. Credential fields accept only
        an existing secret reference; secret values are never sent through this form.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Field.Group>
        <div class="grid gap-4 md:grid-cols-2">
          <Field.Field>
            <Field.Label>Category</Field.Label>
            <Select.Root type="single" value={category} onValueChange={chooseCategory}>
              <Select.Trigger class="w-full">{category.replace('-', ' ')}</Select.Trigger>
              <Select.Content>
                <Select.Item value="object-store">Object store</Select.Item>
                <Select.Item value="routing">Routing</Select.Item>
                <Select.Item value="metrics">Metrics</Select.Item>
              </Select.Content>
            </Select.Root>
          </Field.Field>
          <Field.Field>
            <Field.Label>Backend</Field.Label>
            <Select.Root
              type="single"
              value={kind}
              onValueChange={(value) => {
                kind = value ?? kinds[0] ?? '';
                candidate = null;
                validatedRequest = '';
              }}
            >
              <Select.Trigger class="w-full">{kind}</Select.Trigger>
              <Select.Content>
                {#each kinds as option}
                  <Select.Item value={option}>{option}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </Field.Field>
        </div>

        {#if kind === 'webhook' || (category === 'object-store' && ['s3', 'azure-blob'].includes(kind))}
          <Field.Field>
            <Field.Label for="backend-endpoint">Endpoint URL</Field.Label>
            <Input id="backend-endpoint" type="url" bind:value={endpoint} />
          </Field.Field>
        {/if}
        {#if kind === 'webhook' || (category === 'object-store' && kind !== 'local')}
          <Field.Field>
            <Field.Label for="backend-secret-reference">Secret reference</Field.Label>
            <Input id="backend-secret-reference" bind:value={secretRef} />
            <Field.Description>
              Optional for ambient cloud credentials and unauthenticated webhooks.
            </Field.Description>
          </Field.Field>
        {/if}
        {#if category === 'routing' && kind === 'static'}
          <div class="grid gap-4 md:grid-cols-2">
            <Field.Field>
              <Field.Label for="backend-node">Pinned edge node ID</Field.Label>
              <Input id="backend-node" bind:value={nodeId} />
            </Field.Field>
            <Field.Field>
              <Field.Label for="backend-region">Pinned region</Field.Label>
              <Input id="backend-region" bind:value={region} />
            </Field.Field>
          </div>
        {/if}
        {#if category === 'object-store' && ['s3', 'gcs'].includes(kind)}
          <Field.Field>
            <Field.Label for="backend-bucket">Bucket</Field.Label>
            <Input id="backend-bucket" bind:value={bucket} />
          </Field.Field>
        {/if}
        {#if category === 'object-store' && kind === 'azure-blob'}
          <Field.Field>
            <Field.Label for="backend-container">Container</Field.Label>
            <Input id="backend-container" bind:value={container} />
          </Field.Field>
        {/if}
        {#if category === 'object-store' && kind === 's3'}
          <Field.Field>
            <Field.Label for="backend-region">Region</Field.Label>
            <Input id="backend-region" bind:value={region} />
          </Field.Field>
          <label
            class="flex items-center justify-between rounded-lg border p-3"
            for="backend-force-path-style"
          >
            <span class="text-sm">Force path-style S3 requests</span>
            <Switch id="backend-force-path-style" bind:checked={forcePathStyle} />
          </label>
        {/if}
        {#if category === 'object-store' && kind === 'gcs'}
          <Field.Field>
            <Field.Label for="backend-project">Google Cloud project ID</Field.Label>
            <Input id="backend-project" bind:value={projectId} />
          </Field.Field>
        {/if}
        {#if category === 'object-store' && kind !== 'local'}
          <Field.Field>
            <Field.Label for="backend-prefix">Object key prefix</Field.Label>
            <Input id="backend-prefix" bind:value={prefix} />
          </Field.Field>
        {/if}
        {#if category === 'metrics' && kind === 'webhook'}
          <Field.Field>
            <Field.Label for="backend-interval">Export interval (seconds)</Field.Label>
            <Input
              id="backend-interval"
              type="number"
              min="5"
              max="300"
              bind:value={intervalSeconds}
            />
          </Field.Field>
        {/if}

        {#if candidate}
          <div class="flex items-center gap-3 rounded-lg border p-3">
            <StatusBadge value={candidate.healthy ? 'healthy' : 'unhealthy'} />
            <span class="text-sm">{candidate.message ?? `${candidate.kind} validated`}</span>
          </div>
        {/if}
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onclick={validateCandidate}>
            {busy ? 'Validating…' : 'Validate backend'}
          </Button>
          <Button
            disabled={!candidate?.healthy || validatedRequest !== requestFingerprint()}
            onclick={() => (confirmActivation = true)}>Activate backend</Button
          >
        </div>
      </Field.Group>
    </Card.Content>
  </Card.Root>
</div>

<ConfirmAction
  bind:open={confirmActivation}
  title="Activate this backend?"
  description={category === 'object-store'
    ? 'Stage this object store for every relay role. Playback remains on the current store until all roles restart.'
    : `Replace the active ${category.replace('-', ' ')} backend with ${kind}.`}
  confirmLabel="Activate backend"
  onConfirm={activateCandidate}
/>
