<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Clock3, Save, UserRoundX } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { RetentionConfiguration } from '@vrrelay/contracts';
  import { api, isAuthenticatedError } from '#lib/api';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import * as Alert from '#lib/new-ui/components/ui/alert';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import { Input } from '#lib/new-ui/components/ui/input';
  import { Switch } from '#lib/new-ui/components/ui/switch';
  import { loginRoute } from '#lib/new-ui/state.svelte';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let sessionExpiryEnabled = $state(false);
  let sessionHours = $state(24);
  let staleUserPurgeEnabled = $state(false);
  let staleUserDays = $state(90);

  onMount(load);

  function apply(configuration: RetentionConfiguration) {
    sessionExpiryEnabled = configuration.sessionInactivityDeletionHours !== null;
    if (configuration.sessionInactivityDeletionHours !== null)
      sessionHours = configuration.sessionInactivityDeletionHours;
    staleUserPurgeEnabled = configuration.staleUserPurgeDays !== null;
    if (configuration.staleUserPurgeDays !== null) staleUserDays = configuration.staleUserPurgeDays;
  }

  async function load() {
    loading = true;
    try {
      apply(await api.retentionConfiguration());
      error = '';
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(loginRoute(page.url.pathname));
      error = reason instanceof Error ? reason.message : 'Could not load the retention policy.';
    } finally {
      loading = false;
    }
  }

  function configuration(): RetentionConfiguration {
    if (
      sessionExpiryEnabled &&
      (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 8_760)
    )
      throw new Error('Session inactivity must be between 1 and 8,760 hours.');
    if (
      staleUserPurgeEnabled &&
      (!Number.isInteger(staleUserDays) || staleUserDays < 30 || staleUserDays > 3_650)
    )
      throw new Error('Stale-user inactivity must be between 30 and 3,650 days.');
    return {
      sessionInactivityDeletionHours: sessionExpiryEnabled ? sessionHours : null,
      staleUserPurgeDays: staleUserPurgeEnabled ? staleUserDays : null
    };
  }

  async function save() {
    saving = true;
    try {
      apply(await api.updateRetentionConfiguration(configuration()));
      toast.success('Retention policy updated.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not update retention.');
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Retention"
    description="Remove inactive playback links and stale user records automatically."
  >
    {#snippet actions()}
      <Button disabled={loading || saving} onclick={save}>
        <Save />{saving ? 'Saving…' : 'Save policy'}
      </Button>
    {/snippet}
  </PageHeader>

  <LoadState {loading} {error} empty={false} label="retention policy" variant="form" />

  {#if !loading && !error}
    <Alert.Root>
      <Alert.Title>Changes apply immediately</Alert.Title>
      <Alert.Description>
        Enabling expiry can promptly delete already-old, unpinned links. Only successful media
        delivery counts as playback activity; dashboard views and playlist polling do not.
      </Alert.Description>
    </Alert.Root>

    <div class="grid gap-4 lg:grid-cols-2">
      <Card.Root>
        <Card.Header class="sm:flex-row sm:items-start">
          <div class="bg-muted grid size-10 place-items-center rounded-full">
            <Clock3 class="size-5" />
          </div>
          <div class="min-w-0 flex-1">
            <Card.Title>Idle playback links</Card.Title>
            <Card.Description>
              Delete unpinned sessions after they stop successfully delivering media.
            </Card.Description>
          </div>
          <Switch
            aria-label="Enable idle playback-link expiry"
            checked={sessionExpiryEnabled}
            onCheckedChange={(checked) => (sessionExpiryEnabled = checked)}
          />
        </Card.Header>
        <Card.Content>
          <label class="grid gap-2 text-sm font-medium" for="session-inactivity-hours">
            Hours without playback
            <Input
              id="session-inactivity-hours"
              type="number"
              min="1"
              max="8760"
              step="1"
              disabled={!sessionExpiryEnabled}
              bind:value={sessionHours}
            />
            <span class="text-muted-foreground text-xs font-normal">
              Allowed range: 1 hour to 1 year. Pinned sessions are always retained.
            </span>
          </label>
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header class="sm:flex-row sm:items-start">
          <div class="bg-muted grid size-10 place-items-center rounded-full">
            <UserRoundX class="size-5" />
          </div>
          <div class="min-w-0 flex-1">
            <Card.Title>Stale users</Card.Title>
            <Card.Description>
              Purge ordinary user records that have not signed in for the configured period.
            </Card.Description>
          </div>
          <Switch
            aria-label="Enable stale-user purge"
            checked={staleUserPurgeEnabled}
            onCheckedChange={(checked) => (staleUserPurgeEnabled = checked)}
          />
        </Card.Header>
        <Card.Content>
          <label class="grid gap-2 text-sm font-medium" for="stale-user-days">
            Days since last sign-in
            <Input
              id="stale-user-days"
              type="number"
              min="30"
              max="3650"
              step="1"
              disabled={!staleUserPurgeEnabled}
              bind:value={staleUserDays}
            />
            <span class="text-muted-foreground text-xs font-normal">
              Administrators, owners, active browser sessions, and users who own resources are
              retained.
            </span>
          </label>
        </Card.Content>
      </Card.Root>
    </div>
  {/if}
</div>
