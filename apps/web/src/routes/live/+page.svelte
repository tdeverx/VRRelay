<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Antenna, Copy, LoaderCircle, Plus, Radio, Shield, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { ProfileRevision, PublicLiveChannel } from '@vrrelay/domain';
  import AppShell from '$lib/components/AppShell.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Field from '$lib/components/ui/field';
  let channels = $state<PublicLiveChannel[]>([]),
    profiles = $state<ProfileRevision[]>([]),
    open = $state(false),
    name = $state('OBS live'),
    creating = $state(false),
    deleting = $state(false),
    pendingDelete = $state<PublicLiveChannel | null>(null),
    newSecret = $state<Awaited<ReturnType<typeof api.createLiveChannel>> | null>(null);
  onMount(() => {
    void load();
    const timer = window.setInterval(() => void refreshChannels(), 3_000);
    return () => window.clearInterval(timer);
  });
  async function load() {
    try {
      [channels, profiles] = [
        (await api.liveChannels()).items,
        (await api.profiles()).items.filter((p) => p.delivery.playlistType === 'live')
      ];
    } catch (e) {
      if (isAuthenticatedError(e)) return goto('/login');
      toast.error(e instanceof Error ? e.message : 'Could not load live ingest.');
    }
  }
  async function refreshChannels() {
    try {
      channels = (await api.liveChannels()).items;
    } catch (e) {
      if (isAuthenticatedError(e)) void goto('/login');
    }
  }
  async function create() {
    creating = true;
    try {
      newSecret = await api.createLiveChannel(name);
      channels = [newSecret.channel, ...channels];
      open = false;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create channel.');
    } finally {
      creating = false;
    }
  }
  async function copy(v: string) {
    await navigator.clipboard.writeText(v);
    toast.success('Copied to clipboard.');
  }
  async function session(c: PublicLiveChannel) {
    const p = profiles[0];
    if (!p) return toast.error('No live profile is available.');
    try {
      await api.createLiveSession({
        name: c.name,
        liveChannelId: c.id,
        profileId: p.profileId,
        profileRevision: p.revision,
        platformMode: p.platform
      });
      toast.success('Live playback URL created.');
      goto('/');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create live session.');
    }
  }
  async function deleteChannel() {
    if (!pendingDelete || deleting || pendingDelete.publisherState !== 'offline') return;
    deleting = true;
    try {
      await api.deleteLiveChannel(pendingDelete.id);
      channels = channels.filter((channel) => channel.id !== pendingDelete?.id);
      pendingDelete = null;
      toast.success('Live channel deleted.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete live channel.');
    } finally {
      deleting = false;
    }
  }
  function stateLabel(state: PublicLiveChannel['publisherState']) {
    return state === 'online'
      ? 'Publisher online'
      : state === 'reconnecting'
        ? 'Reconnecting'
        : state === 'error'
          ? 'Publisher error'
          : 'Waiting for publisher';
  }
  function stateVariant(state: PublicLiveChannel['publisherState']) {
    return state === 'online'
      ? ('success' as const)
      : state === 'reconnecting'
        ? ('warning' as const)
        : state === 'error'
          ? ('destructive' as const)
          : ('neutral' as const);
  }
</script>

<AppShell active="live"
  ><div class="page">
    <PageHeader
      title="Live ingest"
      description="One authenticated OBS publisher, centrally fanned out to every viewer."
      >{#snippet actions()}<Button onclick={() => (open = true)}><Plus />New channel</Button
        >{/snippet}</PageHeader
    >
    {#if newSecret}<div class="secret">
        <Shield />
        <div>
          <strong>Save these OBS connection details now</strong>
          <p>The authenticated URLs and publisher token will not be shown again.</p>
          <dl>
            {#each [['Token', newSecret.publisher.publishToken], ['RTMP', newSecret.publisher.rtmpUrl], ['SRT', newSecret.publisher.srtUrl], ['WHIP', newSecret.publisher.whipUrl]] as row}
              <div>
                <dt>{row[0]}</dt>
                <dd><code>{row[1]}</code></dd>
              </div>
            {/each}
          </dl>
        </div>
        <Button variant="outline" size="sm" onclick={() => copy(newSecret!.publisher.rtmpUrl)}
          ><Copy />Copy RTMP</Button
        >
      </div>{/if}
    <div class="list">
      {#each channels as c}<article>
          <div class="channel-title">
            <span><Antenna /></span>
            <div>
              <h2>{c.name}</h2>
              <p>Path /{c.path}</p>
            </div>
            <Badge variant={stateVariant(c.publisherState)}>{stateLabel(c.publisherState)}</Badge>
          </div>
          <div class="channel-actions">
            <span><Radio />Credentials hidden after creation · MediaMTX fan-out</span>
            <div class="action-buttons">
              <Button size="sm" onclick={() => void session(c)}>Create playback URL</Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${c.name}`}
                onclick={() => (pendingDelete = c)}><Trash2 /></Button
              >
            </div>
          </div>
        </article>{/each}
    </div>
  </div>
  <Dialog.Root bind:open
    ><Dialog.Content
      ><Dialog.Header
        ><Dialog.Title>Create live channel</Dialog.Title><Dialog.Description
          >Generates authenticated RTMP, SRT, and WHIP publisher endpoints for one OBS source.</Dialog.Description
        ></Dialog.Header
      ><Field.Field
        ><Field.FieldLabel for="live-channel-name">Channel name</Field.FieldLabel><Input
          id="live-channel-name"
          bind:value={name}
        /></Field.Field
      ><Dialog.Footer
        ><Button variant="outline" onclick={() => (open = false)}>Cancel</Button><Button
          disabled={!name || creating}
          onclick={() => void create()}>{creating ? 'Creating…' : 'Create channel'}</Button
        ></Dialog.Footer
      ></Dialog.Content
    ></Dialog.Root
  ><Dialog.Root
    open={Boolean(pendingDelete)}
    onOpenChange={(next) => !next && !deleting && (pendingDelete = null)}
    ><Dialog.Content
      ><Dialog.Header
        ><Dialog.Title>Delete live channel?</Dialog.Title><Dialog.Description
          >{pendingDelete?.publisherState === 'offline'
            ? `“${pendingDelete?.name}” and its saved publisher authorization will be removed. Delete its playback sessions first.`
            : `Stop the OBS publisher for “${pendingDelete?.name}” before deleting this channel.`}</Dialog.Description
        ></Dialog.Header
      ><Dialog.Footer
        ><Button variant="outline" disabled={deleting} onclick={() => (pendingDelete = null)}
          >Cancel</Button
        ><Button
          variant="destructive"
          disabled={deleting || pendingDelete?.publisherState !== 'offline'}
          onclick={() => void deleteChannel()}
          >{#if deleting}<LoaderCircle
              data-icon="inline-start"
              class="animate-spin"
            />{:else}<Trash2 data-icon="inline-start" />{/if}{deleting
            ? 'Deleting…'
            : 'Delete channel'}</Button
        ></Dialog.Footer
      ></Dialog.Content
    ></Dialog.Root
  ></AppShell
>

<style>
  .page {
    padding: 34px 38px;
  }
  .secret {
    display: flex;
    align-items: flex-start;
    gap: 13px;
    margin-bottom: 18px;
    border: 1px solid color-mix(in oklab, var(--warning) 45%, var(--border));
    border-radius: 8px;
    background: color-mix(in oklab, var(--warning) 7%, var(--card));
    padding: 15px;
  }
  .secret > :global(svg) {
    width: 19px;
    color: var(--warning);
  }
  .secret div {
    min-width: 0;
    flex: 1;
  }
  .secret strong,
  h2 {
    font-size: 13px;
  }
  .secret p,
  .channel-title p {
    margin: 3px 0 8px;
    color: var(--muted-foreground);
    font-size: 11px;
  }
  code {
    font-family: ui-monospace, monospace;
    font-size: 10px;
  }
  .secret dl {
    display: grid;
    gap: 5px;
    margin: 9px 0 0;
  }
  .secret dl div {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    gap: 8px;
  }
  .secret dt {
    color: var(--muted-foreground);
    font-size: 10px;
  }
  .secret dd {
    min-width: 0;
    margin: 0;
  }
  .secret dd code {
    overflow-wrap: anywhere;
  }
  .list {
    display: grid;
    gap: 12px;
  }
  .list article {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
  }
  .channel-title {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
  }
  .channel-title > span {
    display: grid;
    width: 34px;
    height: 34px;
    place-items: center;
    border-radius: 6px;
    background: var(--surface-selected);
    color: var(--primary);
  }
  .channel-title > span :global(svg) {
    width: 17px;
  }
  .channel-title > div {
    flex: 1;
  }
  .channel-title p {
    margin-bottom: 0;
  }
  .channel-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
  }
  .action-buttons {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .channel-actions span {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted-foreground);
    font-size: 10px;
  }
  .channel-actions :global(svg) {
    width: 14px;
  }
  @media (max-width: 650px) {
    .page {
      padding: 24px 16px;
    }
    .secret {
      flex-wrap: wrap;
    }
  }
</style>
