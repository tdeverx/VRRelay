<script lang="ts">
  import { AlertCircle, Inbox } from '@lucide/svelte';
  import * as Alert from '$lib/new-ui/components/ui/alert';
  import * as Empty from '$lib/new-ui/components/ui/empty';
  import { Skeleton } from '$lib/new-ui/components/ui/skeleton';

  let {
    loading = false,
    error = '',
    empty = false,
    label = 'items'
  } = $props<{
    loading?: boolean;
    error?: string;
    empty?: boolean;
    label?: string;
  }>();
</script>

{#if loading}
  <div class="space-y-3" aria-label="Loading">
    {#each Array(4) as _}<Skeleton class="h-14 w-full" />{/each}
  </div>
{:else if error}
  <Alert.Root variant="destructive">
    <AlertCircle />
    <Alert.Title>Could not load {label}</Alert.Title>
    <Alert.Description class="!text-destructive">{error}</Alert.Description>
  </Alert.Root>
{:else if empty}
  <Empty.Root>
    <Empty.Header>
      <Empty.Media variant="icon"><Inbox /></Empty.Media>
      <Empty.Title>No {label} yet</Empty.Title>
      <Empty.Description>There is nothing to show in this section.</Empty.Description>
    </Empty.Header>
  </Empty.Root>
{/if}
