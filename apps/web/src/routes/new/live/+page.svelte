<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Antenna, Copy, Plus, Shield, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { ProfileRevision, PublicLiveChannel } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '$lib/api';
  import { adminRoute } from '$lib/new-ui/state.svelte';
  import PageHeader from '$lib/new-ui/components/PageHeader.svelte';
  import LoadState from '$lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '$lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '$lib/new-ui/components/ui/button';
  import * as Card from '$lib/new-ui/components/ui/card';
  import * as Dialog from '$lib/new-ui/components/ui/dialog';
  import * as AlertDialog from '$lib/new-ui/components/ui/alert-dialog';
  import * as Alert from '$lib/new-ui/components/ui/alert';
  import * as Field from '$lib/new-ui/components/ui/field';
  import { Input } from '$lib/new-ui/components/ui/input';
  import * as Table from '$lib/new-ui/components/ui/table';

  let channels = $state<PublicLiveChannel[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let loading = $state(true);
  let error = $state('');
  let createOpen = $state(false);
  let name = $state('OBS live');
  let busy = $state(false);
  let pendingDelete = $state<PublicLiveChannel | null>(null);
  let pendingReplace = $state<PublicLiveChannel | null>(null);
  let newSecret = $state<Awaited<ReturnType<typeof api.createLiveChannel>> | null>(null);

  onMount(() => {
    void load();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  });

  async function load() {
    try {
      [channels, profiles] = [
        (await api.liveChannels()).items,
        (await api.profiles()).items.filter((profile) => profile.delivery.playlistType === 'live')
      ];
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(adminRoute(page.url.pathname, '/login'));
      error = reason instanceof Error ? reason.message : 'Could not load live channels.';
    } finally {
      loading = false;
    }
  }

  async function refresh() {
    try {
      channels = (await api.liveChannels()).items;
    } catch {
      /* Retain the last useful state. */
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
    const profile = profiles[0];
    if (!profile) return toast.error('No live profile is available.');
    try {
      await api.createLiveSession({
        name: channel.name,
        liveChannelId: channel.id,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        platformMode: profile.platform
      });
      toast.success('Live playback URL created.');
      await goto(adminRoute(page.url.pathname));
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
    await navigator.clipboard.writeText(value);
    toast.success('Copied to clipboard.');
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Live ingest"
    description="One authenticated OBS publisher, centrally fanned out to every viewer."
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
        <dl class="grid gap-2 text-xs md:grid-cols-2">
          {#each [['Token', newSecret.publisher.publishToken], ['RTMP', newSecret.publisher.rtmpUrl], ['SRT', newSecret.publisher.srtUrl], ['WHIP', newSecret.publisher.whipUrl]] as row}
            <div class="min-w-0">
              <dt class="font-medium">{row[0]}</dt>
              <dd class="truncate font-mono">{row[1]}</dd>
            </div>
          {/each}
        </dl>
      </Alert.Description>
      <Alert.Action
        ><Button variant="outline" size="sm" onclick={() => copy(newSecret!.publisher.rtmpUrl)}
          ><Copy data-icon="inline-start" />Copy RTMP</Button
        ></Alert.Action
      >
    </Alert.Root>
  {/if}

  <LoadState
    {loading}
    {error}
    empty={!loading && !error && channels.length === 0}
    label="live channels"
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
