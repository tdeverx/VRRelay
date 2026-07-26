<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    Activity,
    Antenna,
    Copy,
    Database,
    Gauge,
    Network,
    Pin,
    Plus,
    RefreshCw,
    Trash2,
    Users
  } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { RelaySession, SessionRuntimeStats } from '@vrrelay/domain';
  import { api } from '#lib/api';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import ConfirmAction from '#lib/new-ui/components/ConfirmAction.svelte';
  import * as Alert from '#lib/new-ui/components/ui/alert';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import { Switch } from '#lib/new-ui/components/ui/switch';

  let sessions = $state<RelaySession[]>([]);
  let runtime = $state<SessionRuntimeStats[]>([]);
  let currentUser = $state<Awaited<ReturnType<typeof api.me>> | null>(null);
  let loading = $state(true);
  let error = $state('');
  let pendingDelete = $state<RelaySession | null>(null);
  let pinBusyId = $state('');
  let refreshInFlight = false;
  let runtimeBySession = $derived(new Map(runtime.map((stats) => [stats.sessionId, stats])));
  let createdSessionId = $derived(page.url.searchParams.get('created') ?? '');
  let createdSession = $derived(
    sessions.find((session) => session.id === createdSessionId) ?? null
  );
  onMount(() => {
    void load();
    const refresh = window.setInterval(() => void refreshSessions(), 5_000);
    return () => window.clearInterval(refresh);
  });
  async function load() {
    loading = true;
    try {
      const sessionResult = await api.sessions();
      [currentUser, sessions, runtime] = [
        await api.me(),
        sessionResult.items,
        sessionResult.runtime
      ];
      error = '';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Could not load sessions.';
    } finally {
      loading = false;
    }
  }
  async function refreshSessions() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const result = await api.sessions();
      sessions = result.items;
      runtime = result.runtime;
    } catch {
      // Preserve the last useful snapshot; the explicit refresh still surfaces errors.
    } finally {
      refreshInFlight = false;
    }
  }
  let systemWide = $derived(
    currentUser?.authMethod === 'recovery' ||
      Boolean(currentUser?.roles.some((role) => ['operator', 'admin', 'owner'].includes(role)))
  );
  async function copy(session: RelaySession) {
    try {
      await navigator.clipboard.writeText(
        session.outputUrls.primary ?? Object.values(session.outputUrls)[0] ?? ''
      );
      toast.success('Playback URL copied.');
    } catch {
      toast.error('Clipboard access was denied. The playback URL remains available on this page.');
    }
  }
  async function remove(session: RelaySession) {
    await api.deleteSession(session.id);
    sessions = sessions.filter((item) => item.id !== session.id);
    toast.success('Session deleted.');
  }
  async function changePinned(session: RelaySession, pinned: boolean) {
    pinBusyId = session.id;
    try {
      const updated = await api.controlSession(session.id, { pinned });
      sessions = sessions.map((candidate) => (candidate.id === updated.id ? updated : candidate));
      toast.success(pinned ? 'Playback link will be kept.' : 'Playback link can now expire.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not update link retention.');
    } finally {
      pinBusyId = '';
    }
  }
  function mbps(value: number | undefined) {
    return `${(value ?? 0).toFixed((value ?? 0) >= 10 ? 1 : 2)} Mbps`;
  }
  function demandAge(value: number | undefined) {
    if (value === undefined) return 'No demand yet';
    if (value < 1_000) return 'Demand now';
    return `Demand ${Math.round(value / 1_000)}s ago`;
  }
  function lastPlayback(value: string | undefined) {
    return value ? `Last media ${new Date(value).toLocaleString()}` : 'No media delivered yet';
  }
  function producerStatus(stats: SessionRuntimeStats | undefined) {
    switch (stats?.producerState) {
      case 'complete':
        return 'Complete';
      case 'failed':
        return 'Failed';
      case 'idle':
        return 'Idle';
      case 'cancelled':
        return 'Cancelled';
      case 'switching':
        return 'Switching';
    }
    if (stats?.bufferState === 'catching_up') return 'Catching up';
    if (stats?.bufferState === 'buffered') return 'Buffered';
    return stats?.producerState === 'starting' ? 'Starting' : 'No producer';
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
  {#if createdSession}
    <Alert.Root>
      <Alert.Title>Advanced relay created</Alert.Title>
      <Alert.Description class="space-y-2">
        <p>
          {createdSession.name} is ready. Its playback URL is shown here and saved with the session.
        </p>
        <code class="block break-all text-xs">{createdSession.outputUrls.primary}</code>
      </Alert.Description>
      <Alert.Action>
        <Button variant="outline" size="sm" onclick={() => copy(createdSession)}>
          <Copy />Copy URL
        </Button>
      </Alert.Action>
    </Alert.Root>
  {/if}
  <div class="grid gap-3 md:grid-cols-2">
    {#each sessions as session}
      {@const stats = runtimeBySession.get(session.id)}
      <Card.Root class={session.id === createdSessionId ? 'ring-primary ring-2' : ''}
        ><Card.Header
          ><div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <Card.Title class="truncate">{session.name}</Card.Title><Card.Description
                >{session.kind.toUpperCase()}{#if systemWide}
                  · source worker {session.assignedNodeId ??
                    session.placementPolicy}{#if session.kind === 'vod'}
                    · delivery edge selected per viewer region{/if}{/if}</Card.Description
              >
            </div>
            <StatusBadge value={stats?.activity ?? session.state} />
          </div></Card.Header
        ><Card.Content class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div
            class="flex items-center justify-between gap-4 rounded-md border p-3 sm:col-span-2 xl:col-span-3"
          >
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-sm font-medium">
                <Pin class="size-4" />Keep link
              </div>
              <div class="text-muted-foreground text-xs">
                Pinned links are exempt from automatic inactivity deletion.
              </div>
            </div>
            <Switch
              aria-label={`Keep ${session.name} from expiring`}
              checked={session.pinned}
              disabled={pinBusyId === session.id}
              onCheckedChange={(checked) => changePinned(session, checked)}
            />
          </div>
          <code class="break-all rounded-md border p-3 text-xs sm:col-span-2 xl:col-span-3">
            {session.outputUrls.primary ?? Object.values(session.outputUrls)[0] ?? ''}
          </code>
          <div class="rounded-md border p-3">
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <Users class="size-3.5" />Viewers
            </div>
            <div class="mt-1 text-lg font-semibold">{stats?.viewers ?? session.viewers}</div>
            <div class="text-xs text-muted-foreground">
              Estimated over {stats?.viewerWindowSeconds ?? 30}s
            </div>
          </div>
          {#if systemWide}
            <div class="rounded-md border p-3">
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Gauge class="size-3.5" />Transcode
              </div>
              <div class="mt-1 text-lg font-semibold">
                {stats?.transcodeRealtimeFactor === undefined
                  ? 'Waiting'
                  : `${stats.transcodeRealtimeFactor.toFixed(2)}×`}
              </div>
              <div class="text-xs text-muted-foreground">
                {producerStatus(stats)} · {stats?.bufferSeconds.toFixed(1) ?? '0.0'}s producer
                headroom
              </div>
            </div>
            <div class="rounded-md border p-3">
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Network class="size-3.5" />Network
              </div>
              <div class="mt-1 font-semibold">{mbps(stats?.viewerEgressMbps)} out</div>
              <div class="text-xs text-muted-foreground">
                {mbps(stats?.sourceIngressMbps)} from source · {stats?.sourceConnectionCount ?? 0}
                upstream connection{(stats?.sourceConnectionCount ?? 0) === 1 ? '' : 's'}
                · {stats?.sourceRequestsLast30s ?? 0} requests / 30s
              </div>
            </div>
            <div class="rounded-md border p-3">
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Database class="size-3.5" />Delivery cache
              </div>
              <div class="mt-1 text-lg font-semibold">
                {stats?.cacheHitRatio == null ? '—' : `${Math.round(stats.cacheHitRatio * 100)}%`}
              </div>
              <div class="text-xs text-muted-foreground">
                {stats?.cacheHits ?? 0} hits · {stats?.cacheMisses ?? 0} misses
              </div>
            </div>
            <div class="rounded-md border p-3">
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Activity class="size-3.5" />Playback window
              </div>
              <div class="mt-1 font-semibold">
                Published {stats?.lastPublishedSegmentIndex ?? '—'}
              </div>
              <div class="text-xs text-muted-foreground">
                Demanded {stats?.demandedSegmentIndex ?? '—'} · {demandAge(stats?.demandAgeMs)}
                <br />{lastPlayback(
                  stats?.lastPlaybackActivityAt ?? session.lastPlaybackActivityAt
                )}
              </div>
            </div>
            <div class="rounded-md border p-3">
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Antenna class="size-3.5" />Source producer
              </div>
              <div class="mt-1 truncate font-semibold">
                {stats?.sourceWorkerId ?? session.assignedNodeId ?? 'Unassigned'}
              </div>
              <div class="text-xs text-muted-foreground">Generation {stats?.generation ?? '—'}</div>
            </div>
          {/if}
        </Card.Content><Card.Footer class="gap-2"
          ><Button variant="outline" class="flex-1" onclick={() => copy(session)}
            ><Copy />Copy URL</Button
          ><Button
            variant="destructive"
            size="icon"
            aria-label={`Delete ${session.name}`}
            onclick={() => (pendingDelete = session)}><Trash2 /></Button
          ></Card.Footer
        ></Card.Root
      >
    {/each}
  </div>
</div>

<ConfirmAction
  open={Boolean(pendingDelete)}
  onOpenChange={(open) => !open && (pendingDelete = null)}
  title="Delete playback session?"
  description={`Delete ${pendingDelete?.name ?? 'this session'}, revoke its playback URL, and stop any active producer.`}
  confirmLabel="Delete session"
  onConfirm={async () => {
    if (!pendingDelete) return;
    await remove(pendingDelete);
    pendingDelete = null;
  }}
/>
