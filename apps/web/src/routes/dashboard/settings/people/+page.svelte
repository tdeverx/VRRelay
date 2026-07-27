<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ShieldCheck, Trash2, UserRound } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { Profile, UserIdentity, UserRole } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import ConfirmAction from '#lib/new-ui/components/ConfirmAction.svelte';
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
  const followDefaultProfile = '__follow_default__';

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
      role?: UserRole;
      allowedProfileIds?: string[];
      defaultProfileId?: string;
      followDefault?: boolean;
    },
    message: string
  ) {
    busyId = record.value.id;
    try {
      const allowedProfileIds = update.allowedProfileIds ?? record.value.allowedProfileIds;
      const updated = await api.updateUser(record.value.id, {
        expectedRevision: record.revision,
        roles: [update.role ?? record.value.roles[0] ?? 'user'],
        allowedProfileIds,
        ...(!update.followDefault && (update.defaultProfileId ?? record.value.defaultProfileId)
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

  function changeRole(record: UserRecord, role: UserRole) {
    return save(record, { role }, `${record.value.displayName} is now ${role}.`);
  }

  function changeDefaultProfile(record: UserRecord, defaultProfileId: string) {
    if (defaultProfileId === followDefaultProfile)
      return save(
        record,
        { allowedProfileIds: [], followDefault: true },
        `${record.value.displayName} now follows the default profile.`
      );
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
  <PageHeader title="People & access" description="Choose each user's role and profile." />
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
    <div class="grid gap-4 lg:grid-cols-2">
      {#each users as record (record.value.id)}
        <Card.Root class="overflow-hidden">
          <Card.Header>
            <div class="flex items-start gap-3">
              <div class="bg-muted grid size-11 shrink-0 place-items-center rounded-full">
                <UserRound class="size-5" />
              </div>
              <div class="min-w-0 flex-1 pt-0.5">
                <Card.Title>{record.value.displayName}</Card.Title>
                <Card.Description class="mt-1"
                  >Last signed in {new Date(
                    record.value.lastSeenAt
                  ).toLocaleString()}</Card.Description
                >
              </div>
              <Button
                variant="ghost"
                size="icon"
                class="text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0"
                disabled={busyId === record.value.id || currentUser?.id === record.value.id}
                aria-label={`Delete ${record.value.displayName}`}
                title={currentUser?.id === record.value.id
                  ? 'You cannot delete your own user.'
                  : `Delete ${record.value.displayName}`}
                onclick={() => (pendingDelete = record)}><Trash2 /></Button
              >
            </div>
          </Card.Header>
          <Card.Content
            class="bg-muted/20 grid gap-4 border-t pt-5 sm:grid-cols-[9rem_minmax(0,1fr)]"
          >
            <div class="space-y-2">
              <label class="text-sm font-medium" for={`role-${record.value.id}`}>Role</label>
              <Select.Root
                type="single"
                value={record.value.roles[0] ?? 'user'}
                disabled={busyId === record.value.id}
                onValueChange={(value) => value && changeRole(record, value as UserRole)}
              >
                <Select.Trigger
                  id={`role-${record.value.id}`}
                  class="w-full"
                  aria-label={`Role for ${record.value.displayName}`}
                  >{record.value.roles[0] ?? 'user'}</Select.Trigger
                >
                <Select.Content>
                  <Select.Item value="user">User</Select.Item>
                  <Select.Item value="operator">Operator</Select.Item>
                  <Select.Item value="admin">Admin</Select.Item>
                  <Select.Item value="owner">Owner</Select.Item>
                </Select.Content>
              </Select.Root>
              <p class="text-muted-foreground text-xs">Dashboard permissions.</p>
            </div>
            <div class="space-y-2">
              <label class="text-sm font-medium" for={`default-profile-${record.value.id}`}
                >Profile</label
              >
              <Select.Root
                type="single"
                value={record.value.defaultProfileId ?? followDefaultProfile}
                disabled={busyId === record.value.id || profiles.length === 0}
                onValueChange={(value) => value && changeDefaultProfile(record, value)}
              >
                <Select.Trigger id={`default-profile-${record.value.id}`} class="w-full">
                  {record.value.defaultProfileId
                    ? (profiles.find(
                        (profile) => profile.profileId === record.value.defaultProfileId
                      )?.name ?? 'Choose a profile')
                    : 'Auto (follow default)'}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value={followDefaultProfile}>Auto (follow default)</Select.Item>
                  {#each profiles as profile}
                    <Select.Item value={profile.profileId}>{profile.name}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              <p class="text-muted-foreground text-xs">
                Choose one profile or follow the app default automatically.
              </p>
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
