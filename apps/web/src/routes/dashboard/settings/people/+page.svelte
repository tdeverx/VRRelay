<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ShieldCheck, Trash2, UserRound } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { Profile, UserIdentity } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import ConfirmAction from '#lib/new-ui/components/ConfirmAction.svelte';
  import { Badge } from '#lib/new-ui/components/ui/badge';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Select from '#lib/new-ui/components/ui/select';
  import { loginRoute } from '#lib/new-ui/state.svelte';

  type UserRecord = { value: UserIdentity; revision: number };
  let users = $state<UserRecord[]>([]);
  let profiles = $state<Profile[]>([]);
  let currentUser = $state<Awaited<ReturnType<typeof api.me>> | null>(null);
  let loading = $state(true);
  let error = $state('');
  let busyId = $state('');
  let pendingDelete = $state<UserRecord | null>(null);

  onMount(load);

  async function load() {
    try {
      const [userResult, profileResult, me] = await Promise.all([
        api.users(),
        api.profiles(),
        api.me()
      ]);
      users = userResult.items;
      currentUser = me;
      profiles = profileResult.items;
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(loginRoute(page.url.pathname));
      error = reason instanceof Error ? reason.message : 'Could not load people and access.';
    } finally {
      loading = false;
    }
  }

  async function save(
    record: UserRecord,
    update: {
      allowedProfileIds?: string[];
      defaultProfileId?: string;
    },
    message: string
  ) {
    busyId = record.value.id;
    try {
      const allowedProfileIds = update.allowedProfileIds ?? record.value.allowedProfileIds;
      const updated = await api.updateUser(record.value.id, {
        expectedRevision: record.revision,
        roles: record.value.roles,
        allowedProfileIds,
        ...((update.defaultProfileId ?? record.value.defaultProfileId)
          ? { defaultProfileId: update.defaultProfileId ?? record.value.defaultProfileId }
          : {})
      });
      users = users.map((candidate) =>
        candidate.value.id === updated.value.id ? updated : candidate
      );
      toast.success(message);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not update access.');
    } finally {
      busyId = '';
    }
  }

  function changeDefaultProfile(record: UserRecord, defaultProfileId: string) {
    return save(
      record,
      { allowedProfileIds: [defaultProfileId], defaultProfileId },
      `Profile updated for ${record.value.displayName}.`
    );
  }

  async function deletePendingUser() {
    const record = pendingDelete;
    if (!record) return;
    await api.deleteUser(record.value.id, record.revision);
    users = users.filter((candidate) => candidate.value.id !== record.value.id);
    pendingDelete = null;
    toast.success(`${record.value.displayName} was deleted.`);
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="People & access"
    description="Review roles, choose each user's profile, and inspect their entitlements."
  />
  <Card.Root>
    <Card.Header>
      <div class="flex items-center gap-2">
        <ShieldCheck class="size-5" /><Card.Title>Recovery owner</Card.Title>
      </div>
      <Card.Description
        >The local recovery password always retains owner access and does not include a personal
        Jellyfin catalog.</Card.Description
      >
    </Card.Header>
  </Card.Root>

  <LoadState
    {loading}
    {error}
    empty={!loading && !error && users.length === 0}
    label="known users"
    variant="people"
    count={2}
  />
  {#if !loading && !error && users.length > 0}
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {#each users as record (record.value.id)}
        <Card.Root>
          <Card.Header class="gap-4">
            <div class="bg-muted grid size-10 place-items-center rounded-full">
              <UserRound class="size-5" />
            </div>
            <div class="min-w-0 flex-1">
              <Card.Title>{record.value.displayName}</Card.Title>
              <Card.Description
                >Last signed in {new Date(
                  record.value.lastSeenAt
                ).toLocaleString()}</Card.Description
              >
            </div>
            <div class="flex flex-wrap gap-2">
              {#each record.value.roles as role}<Badge variant="outline">{role}</Badge>{/each}
            </div>
            <Button
              variant="destructive"
              size="icon"
              disabled={busyId === record.value.id || currentUser?.id === record.value.id}
              aria-label={`Delete ${record.value.displayName}`}
              title={currentUser?.id === record.value.id
                ? 'You cannot delete your own user.'
                : `Delete ${record.value.displayName}`}
              onclick={() => (pendingDelete = record)}><Trash2 /></Button
            >
          </Card.Header>
          <Card.Content class="grid gap-5 border-t pt-5">
            <div class="space-y-2">
              <label class="text-sm font-medium" for={`default-profile-${record.value.id}`}
                >Default profile</label
              >
              <Select.Root
                type="single"
                value={record.value.defaultProfileId}
                disabled={busyId === record.value.id || profiles.length === 0}
                onValueChange={(value) => value && changeDefaultProfile(record, value)}
              >
                <Select.Trigger id={`default-profile-${record.value.id}`} class="w-full">
                  {profiles.find((profile) => profile.profileId === record.value.defaultProfileId)
                    ?.name ?? 'Choose a profile'}
                </Select.Trigger>
                <Select.Content>
                  {#each profiles as profile}
                    <Select.Item value={profile.profileId}>{profile.name}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              <p class="text-muted-foreground text-xs">
                This is the profile available to the user.
              </p>
            </div>
            <div class="space-y-2">
              <p class="text-sm font-medium">Entitlements</p>
              <div class="flex flex-wrap gap-2">
                {#each record.value.allowedProfileIds as profileId}
                  <Badge variant="secondary"
                    >{profiles.find((profile) => profile.profileId === profileId)?.name ??
                      profileId}</Badge
                  >
                {/each}
              </div>
            </div>
          </Card.Content>
        </Card.Root>
      {/each}
    </div>
  {/if}
</div>

<ConfirmAction
  open={Boolean(pendingDelete)}
  onOpenChange={(open) => !open && (pendingDelete = null)}
  title="Delete user?"
  description={`Delete ${pendingDelete?.value.displayName ?? 'this user'}, revoke their active dashboard sessions, and remove their saved access settings. Users who still own relay sessions or live channels cannot be deleted.`}
  confirmLabel="Delete user"
  onConfirm={deletePendingUser}
/>
