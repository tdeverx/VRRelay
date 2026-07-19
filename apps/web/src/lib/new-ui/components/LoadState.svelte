<script lang="ts">
  import { AlertCircle, Inbox } from '@lucide/svelte';
  import * as Alert from '#lib/new-ui/components/ui/alert';
  import * as Empty from '#lib/new-ui/components/ui/empty';
  import { Skeleton } from '#lib/new-ui/components/ui/skeleton';

  let {
    loading = false,
    error = '',
    empty = false,
    label = 'items',
    variant = 'list',
    count = 4
  } = $props<{
    loading?: boolean;
    error?: string;
    empty?: boolean;
    label?: string;
    variant?: 'list' | 'cards' | 'table' | 'people' | 'metrics' | 'form' | 'media';
    count?: number;
  }>();
</script>

{#if loading}
  <div role="status" aria-live="polite" data-loading-variant={variant} class="space-y-4">
    <span class="sr-only">Loading {label}</span>
    {#if variant === 'cards'}
      <div class="grid gap-3 md:grid-cols-2" aria-hidden="true">
        {#each Array(count) as _}
          <div class="space-y-5 rounded-4xl border p-6 shadow-sm">
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1 space-y-2">
                <Skeleton class="h-5 w-2/3" />
                <Skeleton class="h-4 w-1/2" />
              </div>
              <Skeleton class="h-6 w-20 rounded-full" />
            </div>
            <div class="flex gap-2">
              <Skeleton class="h-9 flex-1" />
              <Skeleton class="size-9" />
            </div>
          </div>
        {/each}
      </div>
    {:else if variant === 'table'}
      <div class="hidden overflow-hidden rounded-xl border md:block" aria-hidden="true">
        <div class="grid grid-cols-5 gap-6 border-b p-4">
          {#each Array(5) as _}<Skeleton class="h-4 w-20" />{/each}
        </div>
        {#each Array(count) as _}
          <div class="grid grid-cols-5 items-center gap-6 border-b p-4 last:border-b-0">
            <Skeleton class="h-4 w-28" />
            <Skeleton class="h-4 w-20" />
            <Skeleton class="h-4 w-24" />
            <Skeleton class="h-6 w-16 rounded-full" />
            <Skeleton class="ms-auto h-8 w-24" />
          </div>
        {/each}
      </div>
      <div class="grid gap-3 md:hidden" aria-hidden="true">
        {#each Array(Math.min(count, 3)) as _}
          <div class="space-y-4 rounded-4xl border p-4 shadow-sm">
            <div class="flex justify-between gap-4">
              <div class="flex-1 space-y-2">
                <Skeleton class="h-5 w-2/3" />
                <Skeleton class="h-4 w-1/2" />
              </div>
              <Skeleton class="h-6 w-16 rounded-full" />
            </div>
            <Skeleton class="h-9 w-full" />
          </div>
        {/each}
      </div>
    {:else if variant === 'people'}
      <div class="grid gap-3" aria-hidden="true">
        {#each Array(count) as _}
          <div class="rounded-4xl border shadow-sm">
            <div class="flex flex-wrap items-center gap-4 p-6">
              <Skeleton class="size-10 rounded-full" />
              <div class="min-w-40 flex-1 space-y-2">
                <Skeleton class="h-5 w-40" />
                <Skeleton class="h-4 w-56 max-w-full" />
              </div>
              <Skeleton class="h-6 w-20 rounded-full" />
              <Skeleton class="h-9 w-full sm:w-40" />
            </div>
            <div class="grid gap-4 border-t p-6 lg:grid-cols-[16rem_1fr]">
              <Skeleton class="h-9 w-full" />
              <div class="grid gap-3 sm:grid-cols-2">
                <Skeleton class="h-12 w-full" /><Skeleton class="h-12 w-full" />
              </div>
            </div>
          </div>
        {/each}
      </div>
    {:else if variant === 'metrics'}
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
        {#each Array(4) as _}
          <div class="space-y-3 rounded-4xl border p-6 shadow-sm">
            <Skeleton class="h-4 w-24" />
            <Skeleton class="h-7 w-32" />
          </div>
        {/each}
      </div>
      <div class="space-y-4 rounded-4xl border p-6 shadow-sm" aria-hidden="true">
        <Skeleton class="h-5 w-40" />
        <Skeleton class="h-4 w-64 max-w-full" />
        <Skeleton class="h-3 w-full rounded-full" />
      </div>
      <div class="space-y-4 rounded-4xl border p-6 shadow-sm" aria-hidden="true">
        <Skeleton class="h-5 w-44" />
        {#each Array(3) as _}<Skeleton class="h-12 w-full" />{/each}
      </div>
    {:else if variant === 'form'}
      <div class="grid gap-4 xl:grid-cols-2" aria-hidden="true">
        {#each Array(2) as _, index}
          <div class="space-y-5 rounded-4xl border p-6 shadow-sm">
            <div class="space-y-2">
              <Skeleton class="h-5 w-40" />
              <Skeleton class="h-4 w-3/4" />
            </div>
            {#each Array(index === 0 ? 3 : 4) as _}
              <div class="space-y-2">
                <Skeleton class="h-4 w-24" />
                <Skeleton class="h-9 w-full" />
              </div>
            {/each}
            <Skeleton class="ms-auto h-9 w-28" />
          </div>
        {/each}
      </div>
    {:else if variant === 'media'}
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden="true">
        {#each Array(count) as _}
          <div class="overflow-hidden rounded-4xl border shadow-sm">
            <Skeleton class="aspect-[2/3] w-full rounded-none" />
            <div class="space-y-3 p-6">
              <Skeleton class="h-5 w-3/4" />
              <Skeleton class="h-4 w-1/2" />
              <Skeleton class="h-4 w-full" />
              <Skeleton class="h-9 w-full" />
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="space-y-3" aria-hidden="true">
        {#each Array(count) as _}<Skeleton class="h-14 w-full" />{/each}
      </div>
    {/if}
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
