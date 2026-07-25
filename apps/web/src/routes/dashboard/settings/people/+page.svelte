<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ShieldCheck, UserRound } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { ProfileRevision, UserIdentity, UserRole } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import { Badge } from '#lib/new-ui/components/ui/badge';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Select from '#lib/new-ui/components/ui/select';
  import { Switch } from '#lib/new-ui/components/ui/switch';
  import { loginRoute } from '#lib/new-ui/state.svelte';

  type UserRecord = { value: UserIdentity; revision: number };
  let users = $state<UserRecord[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let loading = $state(true);
  let error = $state('');
  let busyId = $state('');

  onMount(load);

  async function load() {
    try {
      const [userResult, profileResult] = await Promise.all([api.users(), api.profiles()]);
      users = userResult.items;
      profiles = profileResult.items.filter(
        (profile, index, all) =>
          all.findIndex((item) => item.profileId === profile.profileId) === index
      );
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

  function changeRole(record: UserRecord, role: UserRole) {
    return save(record, { role }, `${record.value.displayName} is now ${role}.`);
  }

  function changeDefaultProfile(record: UserRecord, defaultProfileId: string) {
    const allowedProfileIds = record.value.allowedProfileIds.includes(defaultProfileId)
      ? record.value.allowedProfileIds
      : [...record.value.allowedProfileIds, defaultProfileId];
    return save(
      record,
      { allowedProfileIds, defaultProfileId },
      `Default profile updated for ${record.value.displayName}.`
    );
  }

  function changeProfileAccess(record: UserRecord, profileId: string, allowed: boolean) {
    if (!allowed && record.value.defaultProfileId === profileId) {
      toast.error('Choose another default profile before removing this entitlement.');
      return;
    }
    const allowedProfileIds = allowed
      ? [...new Set([...record.value.allowedProfileIds, profileId])]
      : record.value.allowedProfileIds.filter((id) => id !== profileId);
    return save(
      record,
      { allowedProfileIds },
      `Profile access updated for ${record.value.displayName}.`
    );
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="People & access"
    description="Grant explicit VRRelay roles to people after their first Jellyfin sign-in."
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
    <div class="grid gap-3">
      {#each users as record (record.value.id)}
        <Card.Root>
          <Card.Header class="gap-4 sm:flex-row sm:items-center">
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
            <Badge variant="outline">{record.value.allowedProfileIds.length} profiles</Badge>
            <Select.Root
              type="single"
              value={record.value.roles[0] ?? 'user'}
              disabled={busyId === record.value.id}
              onValueChange={(value) => value && changeRole(record, value as UserRole)}
            >
              <Select.Trigger class="w-full sm:w-40"
                >{record.value.roles[0] ?? 'user'}</Select.Trigger
              >
              <Select.Content>
                <Select.Item value="user">User</Select.Item>
                <Select.Item value="operator">Operator</Select.Item>
                <Select.Item value="admin">Admin</Select.Item>
                <Select.Item value="owner">Owner</Select.Item>
              </Select.Content>
            </Select.Root>
          </Card.Header>
          <Card.Content class="grid gap-5 border-t pt-5 lg:grid-cols-[16rem_1fr]">
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
                Selecting a default also grants access to that profile.
              </p>
            </div>
            <fieldset class="space-y-3" disabled={busyId === record.value.id}>
              <legend class="text-sm font-medium">Profile entitlements</legend>
              {#if profiles.length === 0}
                <p class="text-muted-foreground text-sm">Create a profile to grant access.</p>
              {:else}
                <div class="grid gap-3 sm:grid-cols-2">
                  {#each profiles as profile}
                    <label
                      class="flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3 text-sm"
                    >
                      <span class="truncate">{profile.name}</span>
                      <Switch
                        aria-label={`${profile.name} access for ${record.value.displayName}`}
                        checked={record.value.allowedProfileIds.includes(profile.profileId)}
                        onCheckedChange={(checked) =>
                          changeProfileAccess(record, profile.profileId, checked)}
                      />
                    </label>
                  {/each}
                </div>
              {/if}
            </fieldset>
          </Card.Content>
        </Card.Root>
      {/each}
    </div>
  {/if}
</div>
