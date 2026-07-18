<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Check, Plus, X } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { CompatibilityResult, ProfileRevision } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '$lib/api';
  import { adminRoute } from '$lib/new-ui/state.svelte';
  import PageHeader from '$lib/new-ui/components/PageHeader.svelte';
  import LoadState from '$lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '$lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '$lib/new-ui/components/ui/button';
  import * as Card from '$lib/new-ui/components/ui/card';
  import * as Dialog from '$lib/new-ui/components/ui/dialog';
  import * as Field from '$lib/new-ui/components/ui/field';
  import { Input } from '$lib/new-ui/components/ui/input';
  import * as Select from '$lib/new-ui/components/ui/select';
  import { Switch } from '$lib/new-ui/components/ui/switch';
  import * as Table from '$lib/new-ui/components/ui/table';

  const checks = [
    'startup',
    'duration',
    'pause',
    'forwardSeek',
    'backwardSeek',
    'lateJoin',
    'completion',
    'audio',
    'video'
  ] as const;
  let results = $state<CompatibilityResult[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let loading = $state(true);
  let error = $state('');
  let open = $state(false);
  let platform = $state<'pc' | 'quest'>('pc');
  let player = $state('AVPro');
  let profileKey = $state('');
  let resultState = $state<'experimental' | 'verified' | 'broken' | 'retired'>('experimental');
  let applicationVersion = $state('unknown');
  let notes = $state('');
  let passed = $state<Record<(typeof checks)[number], boolean>>({
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

  onMount(async () => {
    try {
      const [compatibility, profileResult, health] = await Promise.all([
        api.compatibility(),
        api.profiles(),
        api.health()
      ]);
      results = compatibility.items;
      profiles = profileResult.items;
      applicationVersion = health.version;
      if (profiles[0]) profileKey = `${profiles[0].profileId}:${profiles[0].revision}`;
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(adminRoute(page.url.pathname, '/login'));
      error = reason instanceof Error ? reason.message : 'Could not load compatibility evidence.';
    } finally {
      loading = false;
    }
  });

  async function save() {
    const profile = profiles.find((item) => `${item.profileId}:${item.revision}` === profileKey);
    if (!profile) return;
    try {
      const result = await api.createCompatibility({
        applicationVersion,
        platform,
        player,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        state: resultState,
        ...passed,
        notes
      });
      results = [result, ...results];
      open = false;
      toast.success('Compatibility result recorded.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not save result.');
    }
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Compatibility"
    description="Evidence from real VRChat builds, players, platforms and immutable profiles."
  >
    {#snippet actions()}<Button onclick={() => (open = true)}
        ><Plus data-icon="inline-start" />Record test</Button
      >{/snippet}
  </PageHeader>
  <LoadState
    {loading}
    {error}
    empty={!loading && !error && results.length === 0}
    label="compatibility results"
  />
  {#if !loading && !error && results.length}
    <div class="hidden overflow-hidden rounded-xl border md:block">
      <Table.Root
        ><Table.Header
          ><Table.Row
            ><Table.Head>Platform / player</Table.Head><Table.Head>Profile</Table.Head><Table.Head
              >Startup</Table.Head
            ><Table.Head>Duration</Table.Head><Table.Head>Seeking</Table.Head><Table.Head
              >A/V</Table.Head
            ><Table.Head>Evidence</Table.Head></Table.Row
          ></Table.Header
        ><Table.Body
          >{#each results as result}<Table.Row
              ><Table.Cell class="font-medium"
                >{result.platform.toUpperCase()} · {result.player}<span
                  class="text-muted-foreground block text-xs"
                  >{new Date(result.testedAt).toLocaleDateString()}</span
                ></Table.Cell
              ><Table.Cell
                >{profiles.find(
                  (profile) =>
                    profile.profileId === result.profileId &&
                    profile.revision === result.profileRevision
                )?.name ?? result.profileId}</Table.Cell
              >{#each [result.startup, result.duration, result.forwardSeek && result.backwardSeek, result.audio && result.video] as ok}<Table.Cell
                  >{#if ok}<Check class="text-success size-4" />{:else}<X
                      class="text-destructive size-4"
                    />{/if}</Table.Cell
                >{/each}<Table.Cell><StatusBadge value={result.state} /></Table.Cell></Table.Row
            >{/each}</Table.Body
        ></Table.Root
      >
    </div>
    <div class="grid gap-3 md:hidden">
      {#each results as result}<Card.Root
          ><Card.Header
            ><Card.Title>{result.platform.toUpperCase()} · {result.player}</Card.Title
            ><Card.Description>{new Date(result.testedAt).toLocaleDateString()}</Card.Description
            ><Card.Action><StatusBadge value={result.state} /></Card.Action></Card.Header
          ><Card.Content class="text-sm"
            >{profiles.find(
              (profile) =>
                profile.profileId === result.profileId &&
                profile.revision === result.profileRevision
            )?.name ?? result.profileId}</Card.Content
          ></Card.Root
        >{/each}
    </div>
  {/if}
</div>

<Dialog.Root bind:open
  ><Dialog.Content class="sm:max-w-2xl"
    ><Dialog.Header
      ><Dialog.Title>Record a VRChat playback test</Dialog.Title><Dialog.Description
        >Only promote a profile after testing the real platform and player.</Dialog.Description
      ></Dialog.Header
    >
    <div class="grid gap-4 sm:grid-cols-2">
      <Field.Field
        ><Field.Label>Platform</Field.Label><Select.Root type="single" bind:value={platform}
          ><Select.Trigger class="w-full">{platform.toUpperCase()}</Select.Trigger><Select.Content
            ><Select.Item value="pc">PC</Select.Item><Select.Item value="quest">Quest</Select.Item
            ></Select.Content
          ></Select.Root
        ></Field.Field
      ><Field.Field
        ><Field.Label for="compat-player">Player</Field.Label><Input
          id="compat-player"
          bind:value={player}
        /></Field.Field
      ><Field.Field
        ><Field.Label>Profile revision</Field.Label><Select.Root
          type="single"
          bind:value={profileKey}
          ><Select.Trigger class="w-full"
            >{profiles.find((profile) => `${profile.profileId}:${profile.revision}` === profileKey)
              ?.name ?? 'Select profile'}</Select.Trigger
          ><Select.Content
            >{#each profiles as profile}<Select.Item
                value={`${profile.profileId}:${profile.revision}`}
                >{profile.name} · r{profile.revision}</Select.Item
              >{/each}</Select.Content
          ></Select.Root
        ></Field.Field
      ><Field.Field
        ><Field.Label>Evidence state</Field.Label><Select.Root
          type="single"
          bind:value={resultState}
          ><Select.Trigger class="w-full">{resultState}</Select.Trigger><Select.Content
            >{#each ['experimental', 'verified', 'broken', 'retired'] as state}<Select.Item
                value={state}>{state}</Select.Item
              >{/each}</Select.Content
          ></Select.Root
        ></Field.Field
      >
    </div>
    <div class="grid gap-2 sm:grid-cols-3">
      {#each checks as check}<label
          class="flex items-center justify-between rounded-lg border p-3 text-sm"
          for={`check-${check}`}
          ><span>{check.replace(/([A-Z])/g, ' $1')}</span><Switch
            id={`check-${check}`}
            checked={passed[check]}
            onCheckedChange={(checked) => (passed = { ...passed, [check]: checked })}
          /></label
        >{/each}
    </div>
    <Field.Field
      ><Field.Label for="compat-notes">Notes</Field.Label><Input
        id="compat-notes"
        bind:value={notes}
      /></Field.Field
    ><Dialog.Footer
      ><Button variant="outline" onclick={() => (open = false)}>Cancel</Button><Button
        disabled={!profileKey || !player}
        onclick={save}>Save evidence</Button
      ></Dialog.Footer
    ></Dialog.Content
  ></Dialog.Root
>
