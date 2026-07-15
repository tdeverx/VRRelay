<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    Antenna,
    ChevronDown,
    ChevronUp,
    Clock3,
    Copy,
    Cpu,
    Film,
    Link2,
    LoaderCircle,
    MoreHorizontal,
    Plus,
    Search,
    Trash2,
    Users
  } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { ProfileRevision, PublicProviderConnection, RelaySession } from '@vrrelay/domain';
  import AppShell from '$lib/components/AppShell.svelte';
  import ActivityRail from '$lib/components/ActivityRail.svelte';
  import CapacityBand from '$lib/components/CapacityBand.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
  import * as Table from '$lib/components/ui/table';
  import { Input } from '$lib/components/ui/input';
  import { ToggleGroup, ToggleGroupItem } from '$lib/components/ui/toggle-group';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Empty from '$lib/components/ui/empty';
  import { Skeleton } from '$lib/components/ui/skeleton';
  import { formatBitrate, formatDuration } from '$lib/utils';

  let sessions = $state<RelaySession[]>([]);
  let providers = $state<PublicProviderConnection[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let events = $state<
    Array<{ id: string; type: string; timestamp: string; payload: Record<string, unknown> }>
  >([]);
  let ffmpegVersion = $state('FFmpeg');
  let workers = $state({ active: 0, limit: 2, queued: 0 });
  let loading = $state(true);
  let search = $state('');
  let filter = $state('all');
  let selectedId = $state<string | null>(null);
  let pendingDelete = $state<RelaySession | null>(null);
  let deleting = $state(false);

  let visible = $derived(
    sessions.filter(
      (session) =>
        (filter === 'all' || session.kind === filter) &&
        session.name.toLowerCase().includes(search.toLowerCase())
    )
  );
  let activeCount = $derived(
    sessions.filter((session) => session.state === 'active' || session.state === 'live').length
  );
  let liveCount = $derived(sessions.filter((session) => session.kind === 'live').length);
  let selected = $derived(sessions.find((session) => session.id === selectedId));

  onMount(load);

  async function load() {
    loading = true;
    try {
      const [sessionResult, providerResult, profileResult, eventResult, capabilityResult, health] =
        await Promise.all([
          api.sessions(),
          api.providers(),
          api.profiles(),
          api.recentEvents(),
          api.capabilities(),
          api.health()
        ]);
      sessions = sessionResult.items;
      providers = providerResult.items;
      profiles = profileResult.items;
      events = eventResult.items;
      ffmpegVersion = capabilityResult.ffmpegVersion;
      workers = health.workers;
      selectedId ??= sessions[0]?.id ?? null;
    } catch (error) {
      if (isAuthenticatedError(error)) return goto('/login');
      toast.error(error instanceof Error ? error.message : 'Could not load sessions.');
    } finally {
      loading = false;
    }
  }

  function badgeVariant(state: RelaySession['state']): BadgeVariant {
    if (state === 'active' || state === 'live') return 'success';
    if (state === 'queued' || state === 'starting') return 'warning';
    if (state === 'error') return 'destructive';
    return 'neutral';
  }

  function profileName(session: RelaySession): string {
    return (
      profiles.find(
        (profile) =>
          profile.profileId === session.profileId && profile.revision === session.profileRevision
      )?.name ?? session.profileId
    );
  }

  function sessionProfile(session: RelaySession): ProfileRevision | undefined {
    return profiles.find(
      (profile) =>
        profile.profileId === session.profileId && profile.revision === session.profileRevision
    );
  }

  async function copyUrl(url: string) {
    await navigator.clipboard.writeText(url);
    toast.success('Playback URL copied.');
  }

  async function removeSession() {
    if (!pendingDelete) return;
    deleting = true;
    try {
      await api.deleteSession(pendingDelete.id);
      sessions = sessions.filter((session) => session.id !== pendingDelete?.id);
      if (selectedId === pendingDelete.id) selectedId = sessions[0]?.id ?? null;
      pendingDelete = null;
      toast.success('Relay session deleted.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the session.');
    } finally {
      deleting = false;
    }
  }
</script>

<AppShell active="sessions">
  {#snippet rail()}<ActivityRail {events} />{/snippet}
  {#snippet bottom()}<CapacityBand
      activeWorkers={workers.active}
      maxWorkers={workers.limit}
      {ffmpegVersion}
    />{/snippet}

  <div class="page">
    <header class="page-header">
      <div>
        <h1>Sessions</h1>
        <p class="connection">
          <span class:offline={!providers[0]?.healthy}></span>
          {providers[0]
            ? `${providers[0].serverName ?? providers[0].name} connected · ${providers[0].serverVersion ?? 'unknown'}`
            : 'No media provider connected'}
        </p>
      </div>
      <Button size="lg" href="/relay/new">
        <Plus data-icon="inline-start" />
        New relay
      </Button>
    </header>

    <section class="metrics" aria-label="Relay summary">
      <article><Users /><strong>{activeCount}</strong><span>Active</span></article>
      <article><Clock3 /><strong>{workers.queued}</strong><span>Queued</span></article>
      <article><Antenna /><strong>{liveCount}</strong><span>Live channels</span></article>
      <article>
        <Cpu /><strong>{workers.active} / {workers.limit}</strong><span>Encoders</span>
      </article>
    </section>

    <section class="session-region" aria-labelledby="session-table-title">
      <h2 id="session-table-title" class="sr-only">Relay sessions</h2>
      <div class="toolbar">
        <ToggleGroup type="single" bind:value={filter} spacing={1} aria-label="Session type">
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="vod">VOD</ToggleGroupItem>
          <ToggleGroupItem value="live">Live</ToggleGroupItem>
        </ToggleGroup>
        <label class="search-control">
          <Search />
          <span class="sr-only">Search sessions</span>
          <Input bind:value={search} placeholder="Search sessions…" />
        </label>
      </div>

      <div class="table-frame">
        {#if loading}
          <div class="loading-table">
            {#each Array(5) as _}<Skeleton class="h-12 w-full" />{/each}
          </div>
        {:else if visible.length === 0}
          <Empty.Root>
            <Empty.Header>
              <Empty.Media variant="icon"><Film /></Empty.Media>
              <Empty.Title
                >{sessions.length ? 'No matching sessions' : 'No relay sessions yet'}</Empty.Title
              >
              <Empty.Description>
                {sessions.length
                  ? 'Change the current filter or search.'
                  : 'Create a Jellyfin VOD or OBS live relay to generate a playback URL.'}
              </Empty.Description>
            </Empty.Header>
            {#if sessions.length === 0}<Empty.Content
                ><Button href="/relay/new"><Plus data-icon="inline-start" />New relay</Button
                ></Empty.Content
              >{/if}
          </Empty.Root>
        {:else}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Source</Table.Head>
                <Table.Head>Mode</Table.Head>
                <Table.Head>Profile</Table.Head>
                <Table.Head>Viewers</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Output</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each visible as session (session.id)}
                {@const SourceIcon = session.kind === 'live' ? Antenna : Film}
                <Table.Row
                  data-selected={selectedId === session.id || undefined}
                  onclick={() => (selectedId = selectedId === session.id ? null : session.id)}
                >
                  <Table.Cell><span class="source"><SourceIcon />{session.name}</span></Table.Cell>
                  <Table.Cell>{session.kind === 'live' ? 'Live' : 'VOD'}</Table.Cell>
                  <Table.Cell class="profile-cell">{profileName(session)}</Table.Cell>
                  <Table.Cell>{session.viewers}</Table.Cell>
                  <Table.Cell
                    ><Badge variant={badgeVariant(session.state)}>{session.state}</Badge
                    ></Table.Cell
                  >
                  <Table.Cell>
                    <div class="output-actions">
                      <button
                        class="output-link"
                        onclick={(event) => {
                          event.stopPropagation();
                          void copyUrl(session.outputUrls.primary ?? '');
                        }}
                      >
                        {session.outputUrls.primary?.replace(/^https?:\/\//, '').slice(0, 23)}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Copy playback URL"
                        onclick={(event: MouseEvent) => {
                          event.stopPropagation();
                          void copyUrl(session.outputUrls.primary ?? '');
                        }}><Copy /></Button
                      >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete session"
                        onclick={(event: MouseEvent) => {
                          event.stopPropagation();
                          pendingDelete = session;
                        }}><MoreHorizontal /></Button
                      >
                      {#if selectedId === session.id}<ChevronUp />{:else}<ChevronDown />{/if}
                    </div>
                  </Table.Cell>
                </Table.Row>
                {#if selectedId === session.id}
                  <Table.Row class="detail-row">
                    <Table.Cell colspan={6}>
                      <div class="session-detail">
                        <section>
                          <span>Details</span>
                          <dl>
                            <div>
                              <dt>VOD duration</dt>
                              <dd>{formatDuration(session.durationSeconds)}</dd>
                            </div>
                            <div>
                              <dt>Platform</dt>
                              <dd>{session.platformMode}</dd>
                            </div>
                            <div>
                              <dt>Created</dt>
                              <dd>{new Date(session.createdAt).toLocaleString()}</dd>
                            </div>
                          </dl>
                        </section>
                        <section>
                          <span>Encoder</span>
                          <dl>
                            <div>
                              <dt>Current encoder</dt>
                              <dd>{sessionProfile(session)?.video.encoder ?? '—'}</dd>
                            </div>
                            <div>
                              <dt>Resolution</dt>
                              <dd>
                                {sessionProfile(session)
                                  ? `${sessionProfile(session)?.video.width} × ${sessionProfile(session)?.video.height}`
                                  : '—'}
                              </dd>
                            </div>
                            <div>
                              <dt>Bitrate</dt>
                              <dd>
                                {sessionProfile(session)
                                  ? formatBitrate(sessionProfile(session)!.video.bitrateKbps)
                                  : '—'}
                              </dd>
                            </div>
                          </dl>
                        </section>
                        <section class="playback-field">
                          <span><Link2 /> Playback URL</span>
                          <div>
                            <code>{session.outputUrls.primary}</code><Button
                              variant="outline"
                              size="icon"
                              aria-label="Copy URL"
                              onclick={() => void copyUrl(session.outputUrls.primary ?? '')}
                              ><Copy /></Button
                            >
                          </div>
                        </section>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                {/if}
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
      </div>
    </section>
  </div>
</AppShell>

<Dialog.Root open={Boolean(pendingDelete)} onOpenChange={(open) => !open && (pendingDelete = null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete relay session?</Dialog.Title>
      <Dialog.Description
        >The playback link for “{pendingDelete?.name}” will stop working immediately.</Dialog.Description
      >
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (pendingDelete = null)}>Cancel</Button>
      <Button variant="destructive" disabled={deleting} onclick={removeSession}>
        {#if deleting}<LoaderCircle data-icon="inline-start" class="animate-spin" />{:else}<Trash2
            data-icon="inline-start"
          />{/if}
        {deleting ? 'Deleting…' : 'Delete session'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .page {
    min-width: 760px;
    padding: 26px 24px 40px;
  }
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 24px;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 650;
    letter-spacing: -0.035em;
  }
  .connection {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0 0;
    color: var(--muted-foreground);
    font-size: 12px;
  }
  .connection span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
  }
  .connection span.offline {
    background: var(--muted-foreground);
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    min-height: 86px;
    margin-bottom: 20px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in oklab, var(--card) 74%, transparent);
  }
  .metrics article {
    display: grid;
    grid-template-columns: 38px auto;
    grid-template-rows: 1fr 1fr;
    align-items: end;
    column-gap: 12px;
    border-right: 1px solid var(--border);
    padding: 16px 20px;
  }
  .metrics article:last-child {
    border-right: 0;
  }
  .metrics :global(svg) {
    grid-row: 1 / 3;
    align-self: center;
    width: 25px;
    height: 25px;
    color: var(--muted-foreground);
    stroke-width: 1.5;
  }
  .metrics strong {
    font-size: 22px;
    font-weight: 570;
  }
  .metrics span {
    align-self: start;
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 10px;
  }
  .search-control {
    position: relative;
    display: flex;
    width: min(320px, 40%);
    align-items: center;
  }
  .search-control :global(svg) {
    position: absolute;
    left: 11px;
    width: 16px;
    height: 16px;
    color: var(--muted-foreground);
    stroke-width: 1.7;
    pointer-events: none;
  }
  .search-control :global(input) {
    padding-left: 34px;
  }
  .table-frame {
    overflow: hidden;
    min-height: 330px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: color-mix(in oklab, var(--card) 68%, var(--background));
  }
  .table-frame :global(th) {
    height: 46px;
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 560;
    letter-spacing: 0.015em;
  }
  .table-frame :global(td) {
    height: 54px;
    font-size: 12px;
  }
  .table-frame :global(tr[data-selected='true']) {
    background: var(--surface-selected);
    box-shadow: inset 2px 0 var(--primary);
  }
  .source {
    display: inline-flex;
    max-width: 260px;
    align-items: center;
    gap: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source :global(svg) {
    width: 18px;
    height: 18px;
    color: var(--muted-foreground);
    stroke-width: 1.6;
  }
  :global(.profile-cell) {
    max-width: 190px;
    overflow: hidden;
    color: var(--muted-foreground);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .output-actions {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .output-actions > :global(svg) {
    width: 14px;
    height: 14px;
    color: var(--muted-foreground);
  }
  .output-link {
    max-width: 180px;
    overflow: hidden;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--primary);
    font-family: var(--font-mono);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  :global(.detail-row td) {
    height: auto;
    padding: 0;
    background: color-mix(in oklab, var(--card) 78%, var(--background));
  }
  .session-detail {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    padding: 20px;
  }
  .session-detail section {
    min-width: 0;
  }
  .session-detail section > span {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 12px;
    color: var(--foreground);
    font-size: 11px;
    font-weight: 600;
  }
  .session-detail section > span :global(svg) {
    width: 14px;
    height: 14px;
  }
  dl {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin: 0;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 18px;
  }
  dt,
  dd {
    margin: 0;
    font-size: 11px;
  }
  dt {
    color: var(--muted-foreground);
  }
  dd {
    text-align: right;
  }
  .playback-field {
    grid-column: 1 / -1;
  }
  .playback-field > div {
    display: flex;
    min-width: 0;
  }
  code {
    display: block;
    flex: 1;
    overflow: hidden;
    border: 1px solid var(--border);
    border-right: 0;
    border-radius: 7px 0 0 7px;
    padding: 8px 11px;
    color: var(--muted-foreground);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .loading-table {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 46px 0 0;
  }
  @media (max-width: 760px) {
    .page {
      min-width: 0;
      padding: 20px 14px 40px;
    }
    .page-header {
      align-items: center;
    }
    h1 {
      font-size: 24px;
    }
    .metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .metrics article:nth-child(2) {
      border-right: 0;
    }
    .metrics article:nth-child(-n + 2) {
      border-bottom: 1px solid var(--border);
    }
    .toolbar {
      align-items: stretch;
      flex-direction: column;
    }
    .search-control {
      width: 100%;
    }
    .table-frame {
      overflow-x: auto;
    }
    .table-frame :global(table) {
      min-width: 760px;
    }
  }
</style>
