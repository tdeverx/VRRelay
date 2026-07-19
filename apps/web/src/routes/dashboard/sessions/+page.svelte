<script lang="ts">
  import { onMount } from 'svelte';
  import { Antenna, Copy, Plus, RefreshCw, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { RelaySession } from '@vrrelay/domain';
  import { api } from '#lib/api';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';

  let sessions = $state<RelaySession[]>([]);
  let currentUser = $state<Awaited<ReturnType<typeof api.me>> | null>(null);
  let loading = $state(true);
  let error = $state('');
  onMount(load);
  async function load() {
    loading = true;
    try {
      [currentUser, sessions] = [await api.me(), (await api.sessions()).items];
      error = '';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Could not load sessions.';
    } finally {
      loading = false;
    }
  }
  let systemWide = $derived(
    currentUser?.authMethod === 'recovery' ||
      Boolean(currentUser?.roles.some((role) => ['operator', 'admin', 'owner'].includes(role)))
  );
  async function copy(session: RelaySession) {
    await navigator.clipboard.writeText(
      session.outputUrls.primary ?? Object.values(session.outputUrls)[0] ?? ''
    );
    toast.success('Playback URL copied.');
  }
  async function remove(session: RelaySession) {
    await api.deleteSession(session.id);
    sessions = sessions.filter((item) => item.id !== session.id);
    toast.success('Session deleted.');
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title={systemWide ? 'Sessions' : 'Your sessions'}
    description={systemWide
      ? 'All relay sessions and playback links.'
      : 'Your relay links and live playback sessions.'}
  >
    {#snippet actions()}
      <Button href="/dashboard" variant="outline"><Plus />New relay</Button>
      <Button href="/dashboard/live" variant="outline"><Antenna />Stream with OBS</Button>
      <Button variant="outline" size="icon" aria-label="Refresh sessions" onclick={load}
        ><RefreshCw /></Button
      >
    {/snippet}
  </PageHeader>
  <LoadState
    {loading}
    {error}
    empty={!loading && !error && sessions.length === 0}
    label="relay sessions"
    variant="cards"
  />
  <div class="grid gap-3 md:grid-cols-2">
    {#each sessions as session}
      <Card.Root
        ><Card.Header
          ><div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <Card.Title class="truncate">{session.name}</Card.Title><Card.Description
                >{session.kind.toUpperCase()} · source worker
                {session.assignedNodeId ?? session.placementPolicy}{#if session.kind === 'vod'}
                  · delivery edge selected per viewer region{/if}</Card.Description
              >
            </div>
            <StatusBadge value={session.state} />
          </div></Card.Header
        ><Card.Footer class="gap-2"
          ><Button variant="outline" class="flex-1" onclick={() => copy(session)}
            ><Copy />Copy URL</Button
          ><Button
            variant="destructive"
            size="icon"
            aria-label={`Delete ${session.name}`}
            onclick={() => remove(session)}><Trash2 /></Button
          ></Card.Footer
        ></Card.Root
      >
    {/each}
  </div>
</div>
