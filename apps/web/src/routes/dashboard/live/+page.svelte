<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Antenna, Copy, Plus, Shield, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { Profile, PublicLiveChannel } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import { loginRoute } from '#lib/new-ui/state.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Dialog from '#lib/new-ui/components/ui/dialog';
  import * as AlertDialog from '#lib/new-ui/components/ui/alert-dialog';
  import * as Alert from '#lib/new-ui/components/ui/alert';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as Table from '#lib/new-ui/components/ui/table';

  let channels = $state<PublicLiveChannel[]>([]);
  let profiles = $state<Profile[]>([]);
  let currentUser = $state<Awaited<ReturnType<typeof api.me>> | null>(null);
  let loading = $state(true);
  let error = $state('');
  let createOpen = $state(false);
  let name = $state('OBS live');
  let busy = $state(false);
  let pendingDelete = $state<PublicLiveChannel | null>(null);
  let pendingReplace = $state<PublicLiveChannel | null>(null);
  let newSecret = $state<Awaited<ReturnType<typeof api.createLiveChannel>> | null>(null);
  let refreshInFlight = false;

  onMount(() => {
    void load();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  });

  async function load() {
    try {
      currentUser = await api.me();
      const availableProfiles =
        currentUser.authMethod === 'jellyfin' ? await api.catalogProfiles() : await api.profiles();
      [channels, profiles] = [
        (await api.liveChannels()).items,
        availableProfiles.items.filter((profile) => profile.delivery.playlistType === 'live')
      ];
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(loginRoute(page.url.pathname));
      error = reason instanceof Error ? reason.message : 'Could not load live channels.';
    } finally {
      loading = false;
    }
  }

  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      channels = (await api.liveChannels()).items;
    } catch {
      /* Retain the last useful state. */
    } finally {
      refreshInFlight = false;
    }
  }

  async function createChannel() {
    busy = true;
    try {
      newSecret = await api.createLiveChannel(name);
      channels = [newSecret.channel, ...channels];
      createOpen = false;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not create channel.');
    } finally {
      busy = false;
    }
  }

  async function createPlayback(channel: PublicLiveChannel) {
    const profile =
      profiles.find((candidate) => candidate.profileId === 'h264-live-hls') ??
      profiles.find(
        (candidate) =>
          candidate.platform === 'universal' &&
          candidate.delivery.method === 'hls' &&
          candidate.delivery.container === 'mpegts' &&
          candidate.delivery.segmentType === 'mpegts' &&
          candidate.delivery.playlistType === 'live'
      );
    if (!profile) return toast.error('No live profile is available.');
    try {
      await api.createLiveSession({
        name: channel.name,
        liveChannelId: channel.id,
        profileId: profile.profileId,
        platformMode: profile.platform
      });
      toast.success('Live playback URL created.');
      await goto('/dashboard/sessions');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not create playback URL.');
    }
  }

  async function replacePublisher() {
    if (!pendingReplace) return;
    busy = true;
    try {
      newSecret = await api.replaceLivePublisher(pendingReplace.id);
      channels = channels.map((channel) =>
        channel.id === newSecret?.channel.id ? newSecret.channel : channel
      );
      pendingReplace = null;
      toast.success('Replacement OBS credentials issued.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not replace credentials.');
    } finally {
      busy = false;
    }
  }

  async function deleteChannel() {
    if (!pendingDelete || pendingDelete.publisherState !== 'offline') return;
    busy = true;
    try {
      await api.deleteLiveChannel(pendingDelete.id);
      channels = channels.filter((channel) => channel.id !== pendingDelete?.id);
      pendingDelete = null;
      toast.success('Live channel deleted.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not delete channel.');
    } finally {
      busy = false;
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

  function publisherRows() {
    if (!newSecret) return [];
    const publisher = newSecret.publisher;
    return [
      { label: 'Publisher token', value: publisher.publishToken },
      { label: 'RTMP URL', value: publisher.rtmpUrl },
      { label: 'SRT URL', value: publisher.srtUrl },
      { label: 'WHIP URL', value: publisher.whipUrl },
      ...(publisher.backupRtmpUrl
        ? [{ label: 'Backup RTMP URL', value: publisher.backupRtmpUrl }]
        : []),
      ...(publisher.backupSrtUrl
        ? [{ label: 'Backup SRT URL', value: publisher.backupSrtUrl }]
        : [])
    ];
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title={currentUser?.roles.some((role) => ['operator', 'admin', 'owner'].includes(role))
      ? 'Live ingest'
      : 'Stream with OBS'}
    description="Create a private OBS publisher connection, then share its playback URL."
  >
    {#snippet actions()}<Button onclick={() => (createOpen = true)}
        ><Plus data-icon="inline-start" />New channel</Button
      >{/snippet}
  </PageHeader>

  {#if newSecret}
    <Alert.Root>
      <Shield />
      <Alert.Title>Save these OBS connection details now</Alert.Title>
      <Alert.Description class="space-y-3">
        <p>The authenticated URLs and publisher token will not be shown again.</p>
        <dl class="grid gap-3">
          {#each publisherRows() as row}
            <div class="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <div class="min-w-0">
                <dt class="font-medium">{row.label}</dt>
                <dd class="break-all font-mono text-xs">{row.value}</dd>
              </div>
              <Button variant="outline" size="sm" onclick={() => copy(row.value)}>
                <Copy data-icon="inline-start" />Copy
              </Button>
            </div>
          {/each}
        </dl>
      </Alert.Description>
    </Alert.Root>
  {/if}

  <LoadState
    {loading}
    {error}
    empty={!loading && !error && channels.length === 0}
    label="live channels"
    variant="table"
  />
  {#if !loading && !error && channels.length}
    <div class="hidden overflow-hidden rounded-xl border md:block">
      <Table.Root
        ><Table.Header
          ><Table.Row
            ><Table.Head>Channel</Table.Head><Table.Head>Path</Table.Head><Table.Head
              >Publisher</Table.Head
            ><Table.Head>Region</Table.Head><Table.Head
              ><span class="sr-only">Actions</span></Table.Head
            ></Table.Row
          ></Table.Header
        >
        <Table.Body
          >{#each channels as channel}<Table.Row
              ><Table.Cell class="font-medium">{channel.name}</Table.Cell><Table.Cell
                class="font-mono">/{channel.path}</Table.Cell
              ><Table.Cell><StatusBadge value={channel.publisherState} /></Table.Cell><Table.Cell
                >{channel.region ?? 'Automatic'}</Table.Cell
              ><Table.Cell
                ><div class="flex justify-end gap-2">
                  <Button size="sm" onclick={() => createPlayback(channel)}
                    >Create playback URL</Button
                  ><Button variant="outline" size="sm" onclick={() => (pendingReplace = channel)}
                    >Replace credentials</Button
                  ><Button
                    variant="destructive"
                    size="icon-sm"
                    aria-label={`Delete ${channel.name}`}
                    onclick={() => (pendingDelete = channel)}><Trash2 /></Button
                  >
                </div></Table.Cell
              ></Table.Row
            >{/each}</Table.Body
        >
      </Table.Root>
    </div>
    <div class="grid gap-3 md:hidden">
      {#each channels as channel}<Card.Root
          ><Card.Header
            ><Card.Title class="flex items-center gap-2"
              ><Antenna class="size-4" />{channel.name}</Card.Title
            ><Card.Description>/{channel.path}</Card.Description><Card.Action
              ><StatusBadge value={channel.publisherState} /></Card.Action
            ></Card.Header
          ><Card.Footer class="flex-wrap gap-2"
            ><Button size="sm" onclick={() => createPlayback(channel)}>Playback URL</Button><Button
              variant="outline"
              size="sm"
              onclick={() => (pendingReplace = channel)}>Replace credentials</Button
            ><Button
              variant="destructive"
              size="icon-sm"
              aria-label={`Delete ${channel.name}`}
              onclick={() => (pendingDelete = channel)}><Trash2 /></Button
            ></Card.Footer
          ></Card.Root
        >{/each}
    </div>
  {/if}
</div>

<Dialog.Root bind:open={createOpen}
  ><Dialog.Content
    ><Dialog.Header
      ><Dialog.Title>New live channel</Dialog.Title><Dialog.Description
        >Create a one-time authenticated OBS publisher connection.</Dialog.Description
      ></Dialog.Header
    ><Field.Field
      ><Field.Label for="new-channel-name">Channel name</Field.Label><Input
        id="new-channel-name"
        bind:value={name}
      /></Field.Field
    ><Dialog.Footer
      ><Button variant="outline" onclick={() => (createOpen = false)}>Cancel</Button><Button
        disabled={busy || !name.trim()}
        onclick={createChannel}>Create channel</Button
      ></Dialog.Footer
    ></Dialog.Content
  ></Dialog.Root
>

<AlertDialog.Root
  open={Boolean(pendingReplace)}
  onOpenChange={(open) => !open && (pendingReplace = null)}
  ><AlertDialog.Content
    ><AlertDialog.Header
      ><AlertDialog.Title>Replace OBS credentials?</AlertDialog.Title><AlertDialog.Description
        >Existing publisher credentials will stop working immediately.</AlertDialog.Description
      ></AlertDialog.Header
    ><AlertDialog.Footer
      ><AlertDialog.Cancel>Cancel</AlertDialog.Cancel><AlertDialog.Action
        disabled={busy}
        onclick={replacePublisher}>Replace credentials</AlertDialog.Action
      ></AlertDialog.Footer
    ></AlertDialog.Content
  ></AlertDialog.Root
>

<AlertDialog.Root
  open={Boolean(pendingDelete)}
  onOpenChange={(open) => !open && (pendingDelete = null)}
  ><AlertDialog.Content
    ><AlertDialog.Header
      ><AlertDialog.Title>Delete live channel?</AlertDialog.Title><AlertDialog.Description
        >{pendingDelete?.publisherState === 'offline'
          ? 'This channel and its ingest credentials will be removed.'
          : 'Stop the active publisher before deleting this channel.'}</AlertDialog.Description
      ></AlertDialog.Header
    ><AlertDialog.Footer
      ><AlertDialog.Cancel>Cancel</AlertDialog.Cancel><AlertDialog.Action
        variant="destructive"
        disabled={busy || pendingDelete?.publisherState !== 'offline'}
        onclick={deleteChannel}>Delete channel</AlertDialog.Action
      ></AlertDialog.Footer
    ></AlertDialog.Content
  ></AlertDialog.Root
>
