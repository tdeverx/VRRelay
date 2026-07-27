<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Copy, Ellipsis, Pencil, Plus, Trash2 } from '@lucide/svelte';
  import type { CompatibilityResult, Profile } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import { loginRoute } from '#lib/new-ui/state.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as Select from '#lib/new-ui/components/ui/select';
  import { Switch } from '#lib/new-ui/components/ui/switch';
  import * as Table from '#lib/new-ui/components/ui/table';
  import * as DropdownMenu from '#lib/new-ui/components/ui/dropdown-menu';
  import ConfirmAction from '#lib/new-ui/components/ConfirmAction.svelte';
  import { toast } from 'svelte-sonner';

  let profiles = $state<Profile[]>([]);
  let evidence = $state<CompatibilityResult[]>([]);
  let loading = $state(true);
  let error = $state('');
  let recording = $state(false);
  let selectedProfile = $state('');
  let applicationVersion = $state('');
  let player = $state('VRChat');
  let platform = $state<'pc' | 'quest'>('pc');
  let resultState = $state<'experimental' | 'verified' | 'broken'>('verified');
  let notes = $state('');
  let checks = $state({
    startup: true,
    duration: true,
    pause: true,
    forwardSeek: true,
    backwardSeek: true,
    lateJoin: true,
    completion: true,
    audio: true,
    video: true
  });
  let pendingDelete = $state<Profile | null>(null);
  const checkLabels: Record<keyof typeof checks, string> = {
    startup: 'Starts',
    duration: 'Duration',
    pause: 'Pause',
    forwardSeek: 'Seek forward',
    backwardSeek: 'Seek backward',
    lateJoin: 'Late join',
    completion: 'Completes',
    audio: 'Audio',
    video: 'Video'
  };
  onMount(async () => {
    try {
      const [profileResult, evidenceResult] = await Promise.all([
        api.profiles(),
        api.compatibility()
      ]);
      profiles = profileResult.items;
      evidence = evidenceResult.items;
      selectedProfile = profiles[0]?.profileId ?? '';
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(loginRoute(page.url.pathname));
      error = reason instanceof Error ? reason.message : 'Could not load profiles.';
    } finally {
      loading = false;
    }
  });

  function evidenceCount(profile: Profile) {
    return evidence.filter((result) => result.profileId === profile.profileId).length;
  }

  async function recordTest(event: SubmitEvent) {
    event.preventDefault();
    const profileId = selectedProfile;
    if (!profileId || !applicationVersion.trim() || !player.trim()) return;
    recording = true;
    try {
      const result = await api.createCompatibility({
        applicationVersion: applicationVersion.trim(),
        player: player.trim(),
        profileId,
        platform,
        state: resultState,
        ...checks,
        ...(notes.trim() ? { notes: notes.trim() } : {})
      });
      evidence = [result, ...evidence];
      notes = '';
      toast.success('Compatibility evidence recorded.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not record the test.');
    } finally {
      recording = false;
    }
  }

  async function deletePendingProfile() {
    if (!pendingDelete) return;
    const deleted = pendingDelete;
    await api.deleteProfile(deleted.profileId);
    profiles = profiles.filter((profile) => profile.profileId !== deleted.profileId);
    pendingDelete = null;
    toast.success(`${deleted.name} was deleted.`);
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader title="Profiles" description="Encoding and delivery presets shared by every relay.">
    {#snippet actions()}<Button href="/dashboard/settings/profiles/new"
        ><Plus data-icon="inline-start" />New profile</Button
      >{/snippet}
  </PageHeader>
  <LoadState
    {loading}
    {error}
    empty={!loading && !error && profiles.length === 0}
    label="profiles"
    variant="table"
  />
  {#if !loading && !error && profiles.length}
    <div class="hidden overflow-hidden rounded-xl border md:block">
      <Table.Root
        ><Table.Header
          ><Table.Row
            ><Table.Head>Name</Table.Head><Table.Head>Platform</Table.Head><Table.Head
              >Video</Table.Head
            ><Table.Head>Delivery</Table.Head><Table.Head>Evidence</Table.Head><Table.Head
              >Status</Table.Head
            ><Table.Head><span class="sr-only">Actions</span></Table.Head></Table.Row
          ></Table.Header
        >
        <Table.Body
          >{#each profiles as profile}<Table.Row
              ><Table.Cell class="font-medium">{profile.name}</Table.Cell><Table.Cell
                >{profile.platform}</Table.Cell
              ><Table.Cell
                >{profile.video.codec} · {profile.video.width}×{profile.video.height}</Table.Cell
              ><Table.Cell>{profile.delivery.playlistType}</Table.Cell><Table.Cell
                >{evidenceCount(profile)} tests</Table.Cell
              ><Table.Cell><StatusBadge value={profile.state ?? 'experimental'} /></Table.Cell
              ><Table.Cell
                ><DropdownMenu.Root
                  ><DropdownMenu.Trigger
                    >{#snippet child({ props })}<Button
                        {...props}
                        variant="ghost"
                        size="icon"
                        aria-label={`Actions for ${profile.name}`}><Ellipsis /></Button
                      >{/snippet}</DropdownMenu.Trigger
                  ><DropdownMenu.Content align="end"
                    ><DropdownMenu.Item
                      onclick={() =>
                        goto(
                          `/dashboard/settings/profiles/new?edit=${encodeURIComponent(profile.profileId)}`
                        )}><Pencil />Edit</DropdownMenu.Item
                    ><DropdownMenu.Item
                      onclick={() =>
                        goto(
                          `/dashboard/settings/profiles/new?duplicate=${encodeURIComponent(profile.profileId)}`
                        )}><Copy />Duplicate</DropdownMenu.Item
                    ><DropdownMenu.Item
                      variant="destructive"
                      onclick={() => (pendingDelete = profile)}><Trash2 />Delete</DropdownMenu.Item
                    ></DropdownMenu.Content
                  ></DropdownMenu.Root
                ></Table.Cell
              ></Table.Row
            >{/each}</Table.Body
        >
      </Table.Root>
    </div>
    <div class="grid gap-3 md:hidden">
      {#each profiles as profile}<Card.Root
          ><Card.Header
            ><Card.Title>{profile.name}</Card.Title><Card.Description
              >{profile.platform}</Card.Description
            ><Card.Action class="flex items-center gap-1"
              ><StatusBadge value={profile.state ?? 'experimental'} /><DropdownMenu.Root
                ><DropdownMenu.Trigger
                  >{#snippet child({ props })}<Button
                      {...props}
                      variant="ghost"
                      size="icon"
                      aria-label={`Actions for ${profile.name}`}><Ellipsis /></Button
                    >{/snippet}</DropdownMenu.Trigger
                ><DropdownMenu.Content align="end"
                  ><DropdownMenu.Item
                    onclick={() =>
                      goto(
                        `/dashboard/settings/profiles/new?edit=${encodeURIComponent(profile.profileId)}`
                      )}><Pencil />Edit</DropdownMenu.Item
                  ><DropdownMenu.Item
                    onclick={() =>
                      goto(
                        `/dashboard/settings/profiles/new?duplicate=${encodeURIComponent(profile.profileId)}`
                      )}><Copy />Duplicate</DropdownMenu.Item
                  ><DropdownMenu.Item
                    variant="destructive"
                    onclick={() => (pendingDelete = profile)}><Trash2 />Delete</DropdownMenu.Item
                  ></DropdownMenu.Content
                ></DropdownMenu.Root
              ></Card.Action
            ></Card.Header
          ><Card.Content class="text-sm"
            >{profile.video.codec} · {profile.video.width}×{profile.video.height} · {profile
              .delivery.playlistType} · {evidenceCount(profile)} tests</Card.Content
          ></Card.Root
        >{/each}
    </div>
  {/if}

  {#if !loading && !error && profiles.length}
    <Card.Root>
      <Card.Header>
        <Card.Title>Record a playback test</Card.Title>
        <Card.Description>
          Attach compatibility evidence to the profile that was tested.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <form class="space-y-5" onsubmit={recordTest}>
          <Field.Group class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field.Field>
              <Field.Label for="evidence-profile">Profile</Field.Label>
              <Select.Root type="single" bind:value={selectedProfile}>
                <Select.Trigger id="evidence-profile" class="w-full">
                  {profiles.find((profile) => profile.profileId === selectedProfile)?.name ??
                    'Choose a profile'}
                </Select.Trigger>
                <Select.Content>
                  {#each profiles as profile}
                    <Select.Item value={profile.profileId}>{profile.name}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </Field.Field>
            <Field.Field>
              <Field.Label for="evidence-version">Application version</Field.Label>
              <Input id="evidence-version" bind:value={applicationVersion} required />
            </Field.Field>
            <Field.Field>
              <Field.Label for="evidence-player">Player</Field.Label>
              <Input id="evidence-player" bind:value={player} required />
            </Field.Field>
            <Field.Field>
              <Field.Label for="evidence-platform">Platform</Field.Label>
              <Select.Root type="single" bind:value={platform}>
                <Select.Trigger id="evidence-platform" class="w-full">{platform}</Select.Trigger>
                <Select.Content>
                  <Select.Item value="pc">PC</Select.Item>
                  <Select.Item value="quest">Quest</Select.Item>
                </Select.Content>
              </Select.Root>
            </Field.Field>
          </Field.Group>
          <fieldset class="space-y-3">
            <legend class="text-sm font-medium">Observed behavior</legend>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {#each Object.entries(checkLabels) as [key, label]}
                <label
                  class="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
                >
                  <span>{label}</span>
                  <Switch
                    aria-label={label}
                    checked={checks[key as keyof typeof checks]}
                    onCheckedChange={(checked) => (checks = { ...checks, [key]: checked })}
                  />
                </label>
              {/each}
            </div>
          </fieldset>
          <Field.Group class="grid gap-4 md:grid-cols-[12rem_1fr]">
            <Field.Field>
              <Field.Label for="evidence-state">Result</Field.Label>
              <Select.Root type="single" bind:value={resultState}>
                <Select.Trigger id="evidence-state" class="w-full">{resultState}</Select.Trigger>
                <Select.Content>
                  <Select.Item value="verified">Verified</Select.Item>
                  <Select.Item value="experimental">Experimental</Select.Item>
                  <Select.Item value="broken">Broken</Select.Item>
                </Select.Content>
              </Select.Root>
            </Field.Field>
            <Field.Field>
              <Field.Label for="evidence-notes">Notes</Field.Label>
              <textarea
                id="evidence-notes"
                bind:value={notes}
                class="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/30 min-h-20 w-full rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-3"
              ></textarea>
            </Field.Field>
          </Field.Group>
          <Button
            type="submit"
            disabled={recording || !selectedProfile || !applicationVersion.trim()}
          >
            {recording ? 'Recording…' : 'Record test'}
          </Button>
        </form>
      </Card.Content>
    </Card.Root>
  {/if}
</div>

<ConfirmAction
  open={Boolean(pendingDelete)}
  onOpenChange={(open) => !open && (pendingDelete = null)}
  title="Delete profile?"
  description={`Delete ${pendingDelete?.name ?? 'this profile'}. Profiles assigned to a session, live channel, compatibility result, or user cannot be deleted.`}
  confirmLabel="Delete profile"
  onConfirm={deletePendingProfile}
/>
