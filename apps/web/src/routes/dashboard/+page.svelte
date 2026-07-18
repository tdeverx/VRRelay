<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    Antenna,
    ChevronDown,
    ChevronUp,
    Clock3,
    Copy,
    Cpu,
    Film,
    Link2,
    Pin,
    PinOff,
    Play,
    Plus,
    Search,
    Square,
    Trash2,
    Users
  } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { SessionControlRequest } from '@vrrelay/contracts';
  import type { ProfileRevision, PublicProviderConnection, RelaySession } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import { adminRoute } from '#lib/new-ui/state.svelte';
  import { formatBitrate, formatDuration } from '#lib/utils';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as Table from '#lib/new-ui/components/ui/table';
  import * as ToggleGroup from '#lib/new-ui/components/ui/toggle-group';
  import * as AlertDialog from '#lib/new-ui/components/ui/alert-dialog';

  let sessions = $state<RelaySession[]>([]);
  let providers = $state<PublicProviderConnection[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let events = $state<Awaited<ReturnType<typeof api.recentEvents>>['items']>([]);
  let workers = $state({ active: 0, limit: 0, queued: 0 });
  let loading = $state(true);
  let error = $state('');
  let search = $state('');
  let filter = $state('all');
  let expanded = $state<string | null>(null);
  let pendingDelete = $state<RelaySession | null>(null);
  let busyId = $state<string | null>(null);

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

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      const [sessionResult, providerResult, profileResult, eventResult, health] = await Promise.all(
        [api.sessions(), api.providers(), api.profiles(), api.recentEvents(), api.health()]
      );
      sessions = sessionResult.items;
      providers = providerResult.items;
      profiles = profileResult.items;
      events = eventResult.items;
      workers = health.workers;
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(adminRoute(page.url.pathname, '/login'));
      error = reason instanceof Error ? reason.message : 'Could not load sessions.';
    } finally {
      loading = false;
    }
  }

  function profileName(session: RelaySession) {
    return (
      profiles.find(
        (profile) =>
          profile.profileId === session.profileId && profile.revision === session.profileRevision
      )?.name ?? session.profileId
    );
  }

  function sessionProfile(session: RelaySession) {
    return profiles.find(
      (profile) =>
        profile.profileId === session.profileId && profile.revision === session.profileRevision
    );
  }

  function resumeState(session: RelaySession): 'idle' | 'live' | 'stopped' {
    return session.state === 'stopped' ? (session.kind === 'live' ? 'live' : 'idle') : 'stopped';
  }

  async function copyUrl(session: RelaySession) {
    const url = Object.values(session.outputUrls)[0];
    if (!url) return;
    await navigator.clipboard.writeText(url);
    toast.success('Playback URL copied.');
  }

  async function control(session: RelaySession, request: SessionControlRequest) {
    busyId = session.id;
    try {
      const updated = await api.controlSession(session.id, request);
      sessions = sessions.map((candidate) => (candidate.id === updated.id ? updated : candidate));
      toast.success('Session updated.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not update session.');
    } finally {
      busyId = null;
    }
  }

  async function removeSession() {
    if (!pendingDelete) return;
    busyId = pendingDelete.id;
    try {
      await api.deleteSession(pendingDelete.id);
      sessions = sessions.filter((session) => session.id !== pendingDelete?.id);
      pendingDelete = null;
      toast.success('Relay session deleted.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not delete session.');
    } finally {
      busyId = null;
    }
  }
</script>

<div class="grid min-h-full 2xl:grid-cols-[minmax(0,1fr)_20rem]">
  <div class="min-w-0 space-y-6 p-4 md:p-6">
    <PageHeader
      title="Sessions"
      description={providers[0]
        ? `${providers[0].serverName ?? providers[0].name} connected`
        : 'No media provider connected'}
    >
      {#snippet actions()}
        <Button href={adminRoute(page.url.pathname, '/relay/new')}
          ><Plus data-icon="inline-start" />New relay</Button
        >
      {/snippet}
    </PageHeader>

    <section
      class="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-4"
      aria-label="Relay summary"
    >
      {#each [{ label: 'Active', value: activeCount, icon: Users }, { label: 'Queued', value: workers.queued, icon: Clock3 }, { label: 'Live channels', value: liveCount, icon: Antenna }, { label: 'Workers', value: `${workers.active} / ${workers.limit}`, icon: Cpu }] as metric}
        <div class="bg-card flex items-center gap-3 p-4">
          <metric.icon class="text-muted-foreground size-5" />
          <div>
            <strong class="block text-xl">{metric.value}</strong><span
              class="text-muted-foreground text-xs">{metric.label}</span
            >
          </div>
        </div>
      {/each}
    </section>

    <section class="space-y-4" aria-labelledby="sessions-title">
      <h2 id="sessions-title" class="sr-only">Relay sessions</h2>
      <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <ToggleGroup.Root
          type="single"
          bind:value={filter}
          variant="outline"
          aria-label="Session type"
        >
          <ToggleGroup.Item value="all">All</ToggleGroup.Item>
          <ToggleGroup.Item value="vod">VOD</ToggleGroup.Item>
          <ToggleGroup.Item value="live">Live</ToggleGroup.Item>
        </ToggleGroup.Root>
        <label class="relative block md:w-72">
          <Search
            class="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
          />
          <span class="sr-only">Search sessions</span>
          <Input class="ps-9" bind:value={search} placeholder="Search sessions…" />
        </label>
      </div>

      <LoadState
        {loading}
        {error}
        empty={!loading && !error && visible.length === 0}
        label="relay sessions"
      />

      {#if !loading && !error && visible.length > 0}
        <div class="hidden overflow-hidden rounded-xl border md:block">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Session</Table.Head><Table.Head>Type</Table.Head><Table.Head
                  >Status</Table.Head
                >
                <Table.Head>Profile</Table.Head><Table.Head>Viewers</Table.Head><Table.Head
                  >Placement</Table.Head
                >
                <Table.Head><span class="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each visible as session (session.id)}
                <Table.Row>
                  <Table.Cell class="font-medium">{session.name}</Table.Cell>
                  <Table.Cell class="uppercase">{session.kind}</Table.Cell>
                  <Table.Cell><StatusBadge value={session.state} /></Table.Cell>
                  <Table.Cell>{profileName(session)}</Table.Cell>
                  <Table.Cell>{session.viewers}</Table.Cell>
                  <Table.Cell>{session.assignedNodeId ?? session.placementPolicy}</Table.Cell>
                  <Table.Cell>
                    <div class="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Copy playback URL"
                        onclick={() => copyUrl(session)}><Copy /></Button
                      >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={session.pinned ? 'Unpin session' : 'Pin session'}
                        disabled={busyId === session.id}
                        onclick={() => control(session, { pinned: !session.pinned })}
                        >{#if session.pinned}<PinOff />{:else}<Pin />{/if}</Button
                      >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={session.state === 'stopped' ? 'Start session' : 'Stop session'}
                        disabled={busyId === session.id}
                        onclick={() =>
                          control(session, {
                            state: resumeState(session)
                          })}
                        >{#if session.state === 'stopped'}<Play />{:else}<Square />{/if}</Button
                      >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Show session details"
                        aria-expanded={expanded === session.id}
                        onclick={() => (expanded = expanded === session.id ? null : session.id)}
                        >{#if expanded === session.id}<ChevronUp />{:else}<ChevronDown
                          />{/if}</Button
                      >
                      <Button
                        variant="destructive"
                        size="icon-sm"
                        aria-label="Delete session"
                        onclick={() => (pendingDelete = session)}><Trash2 /></Button
                      >
                    </div>
                  </Table.Cell>
                </Table.Row>
                {#if expanded === session.id}
                  <Table.Row>
                    <Table.Cell colspan={7} class="bg-muted/30">
                      <dl class="grid gap-3 text-sm lg:grid-cols-3">
                        <div>
                          <dt class="text-muted-foreground">Session ID</dt>
                          <dd class="font-mono">{session.id}</dd>
                        </div>
                        <div>
                          <dt class="text-muted-foreground">Duration</dt>
                          <dd>{formatDuration(session.durationSeconds)}</dd>
                        </div>
                        <div>
                          <dt class="text-muted-foreground">Platform</dt>
                          <dd>{session.platformMode}</dd>
                        </div>
                        <div>
                          <dt class="text-muted-foreground">Created</dt>
                          <dd>{new Date(session.createdAt).toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt class="text-muted-foreground">Encoder</dt>
                          <dd>{sessionProfile(session)?.video.encoder ?? '—'}</dd>
                        </div>
                        <div>
                          <dt class="text-muted-foreground">Resolution</dt>
                          <dd>
                            {sessionProfile(session)
                              ? `${sessionProfile(session)?.video.width} × ${sessionProfile(session)?.video.height}`
                              : '—'}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-muted-foreground">Bitrate</dt>
                          <dd>
                            {sessionProfile(session)
                              ? formatBitrate(sessionProfile(session)!.video.bitrateKbps)
                              : '—'}
                          </dd>
                        </div>
                      </dl>
                      {#if session.outputUrls.primary}<div class="mt-4 flex flex-col gap-2">
                          <span class="text-muted-foreground flex items-center gap-2 text-xs"
                            ><Link2 />Playback URL</span
                          >
                          <div class="flex items-center gap-2">
                            <code class="min-w-0 flex-1 break-all text-xs"
                              >{session.outputUrls.primary}</code
                            >
                            <Button variant="outline" size="sm" onclick={() => copyUrl(session)}
                              ><Copy data-icon="inline-start" />Copy</Button
                            >
                          </div>
                        </div>{/if}
                      {#if session.errorMessage}<p class="text-destructive mt-3">
                          {session.errorMessage}
                        </p>{/if}
                    </Table.Cell>
                  </Table.Row>
                {/if}
              {/each}
            </Table.Body>
          </Table.Root>
        </div>

        <div class="grid gap-3 md:hidden">
          {#each visible as session (session.id)}
            <Card.Root>
              <Card.Header>
                <Card.Title>{session.name}</Card.Title>
                <Card.Description
                  >{session.kind.toUpperCase()} · {profileName(session)}</Card.Description
                >
                <Card.Action><StatusBadge value={session.state} /></Card.Action>
              </Card.Header>
              <Card.Content class="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span class="text-muted-foreground block text-xs">Viewers</span>{session.viewers}
                </div>
                <div>
                  <span class="text-muted-foreground block text-xs">Placement</span
                  >{session.assignedNodeId ?? session.placementPolicy}
                </div>
                {#if expanded === session.id}
                  <div class="col-span-2 grid gap-3 border-t pt-3 sm:grid-cols-2">
                    <div>
                      <span class="text-muted-foreground block text-xs">Duration</span
                      >{formatDuration(session.durationSeconds)}
                    </div>
                    <div>
                      <span class="text-muted-foreground block text-xs">Platform</span
                      >{session.platformMode}
                    </div>
                    <div>
                      <span class="text-muted-foreground block text-xs">Encoder</span
                      >{sessionProfile(session)?.video.encoder ?? '—'}
                    </div>
                    <div>
                      <span class="text-muted-foreground block text-xs">Resolution</span
                      >{sessionProfile(session)
                        ? `${sessionProfile(session)?.video.width} × ${sessionProfile(session)?.video.height}`
                        : '—'}
                    </div>
                    <div>
                      <span class="text-muted-foreground block text-xs">Bitrate</span
                      >{sessionProfile(session)
                        ? formatBitrate(sessionProfile(session)!.video.bitrateKbps)
                        : '—'}
                    </div>
                    <div>
                      <span class="text-muted-foreground block text-xs">Created</span>{new Date(
                        session.createdAt
                      ).toLocaleString()}
                    </div>
                    {#if session.outputUrls.primary}<code class="col-span-2 break-all text-xs"
                        >{session.outputUrls.primary}</code
                      >{/if}
                  </div>
                {/if}
              </Card.Content>
              <Card.Footer class="flex-wrap gap-2">
                <Button variant="outline" size="sm" onclick={() => copyUrl(session)}
                  ><Copy data-icon="inline-start" />Copy URL</Button
                >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={session.pinned ? 'Unpin session' : 'Pin session'}
                  onclick={() => control(session, { pinned: !session.pinned })}
                  >{#if session.pinned}<PinOff />{:else}<Pin />{/if}</Button
                >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={session.state === 'stopped' ? 'Start session' : 'Stop session'}
                  onclick={() => control(session, { state: resumeState(session) })}
                  >{#if session.state === 'stopped'}<Play />{:else}<Square />{/if}</Button
                >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Show session details"
                  aria-expanded={expanded === session.id}
                  onclick={() => (expanded = expanded === session.id ? null : session.id)}
                  >{#if expanded === session.id}<ChevronUp />{:else}<ChevronDown />{/if}</Button
                >
                <Button
                  variant="destructive"
                  size="icon-sm"
                  aria-label="Delete session"
                  onclick={() => (pendingDelete = session)}><Trash2 /></Button
                >
              </Card.Footer>
            </Card.Root>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  <aside class="hidden border-l p-6 2xl:block" aria-labelledby="activity-title">
    <h2 id="activity-title" class="font-semibold">Recent activity</h2>
    <ol class="mt-4 space-y-4">
      {#each events.slice(0, 12) as event}
        <li class="border-s ps-3 text-sm">
          <strong class="block">{event.type.replaceAll('.', ' ')}</strong>
          <time class="text-muted-foreground text-xs" datetime={event.timestamp}
            >{new Date(event.timestamp).toLocaleString()}</time
          >
        </li>
      {:else}
        <li class="text-muted-foreground text-sm">No recent activity.</li>
      {/each}
    </ol>
  </aside>
</div>

<AlertDialog.Root
  open={Boolean(pendingDelete)}
  onOpenChange={(open) => !open && (pendingDelete = null)}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete relay session?</AlertDialog.Title>
      <AlertDialog.Description>
        {pendingDelete ? `This permanently removes “${pendingDelete.name}”.` : ''}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={removeSession}>Delete session</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
