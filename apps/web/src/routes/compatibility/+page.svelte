<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Check, Plus, X } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { CompatibilityResult, ProfileRevision } from '@vrrelay/domain';
  import AppShell from '$lib/components/AppShell.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Field from '$lib/components/ui/field';
  import * as Select from '$lib/components/ui/select';
  import * as Table from '$lib/components/ui/table';
  let results = $state<CompatibilityResult[]>([]),
    profiles = $state<ProfileRevision[]>([]),
    open = $state(false),
    platform = $state<'pc' | 'quest'>('pc'),
    player = $state('AVPro'),
    profileKey = $state(''),
    resultState = $state<'experimental' | 'verified' | 'broken' | 'retired'>('experimental'),
    applicationVersion = $state('unknown'),
    notes = $state('');
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
  const variant = (v: CompatibilityResult['state']): BadgeVariant =>
    v === 'verified'
      ? 'success'
      : v === 'broken'
        ? 'destructive'
        : v === 'experimental'
          ? 'warning'
          : 'neutral';
  onMount(load);
  async function load() {
    try {
      const [compatibility, profileResponse, health] = await Promise.all([
        api.compatibility(),
        api.profiles(),
        api.health()
      ]);
      results = compatibility.items;
      profiles = profileResponse.items;
      applicationVersion = health.version;
      const p = profiles[0];
      if (p) profileKey = `${p.profileId}:${p.revision}`;
    } catch (e) {
      if (isAuthenticatedError(e)) return goto('/login');
    }
  }
  async function save() {
    const p = profiles.find((p) => `${p.profileId}:${p.revision}` === profileKey);
    if (!p) return;
    try {
      const result = await api.createCompatibility({
        applicationVersion,
        platform,
        player,
        profileId: p.profileId,
        profileRevision: p.revision,
        state: resultState,
        ...passed,
        notes
      });
      results = [result, ...results];
      open = false;
      toast.success('Compatibility result recorded.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save result.');
    }
  }
</script>

<AppShell active="compatibility"
  ><div class="page">
    <PageHeader
      title="Compatibility"
      description="Evidence from real VRChat builds, players, platforms, and immutable profiles."
      >{#snippet actions()}<Button onclick={() => (open = true)}><Plus />Record test</Button
        >{/snippet}</PageHeader
    >
    <div class="table">
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
          >{#each results as r}<Table.Row
              ><Table.Cell
                ><strong>{r.platform.toUpperCase()} · {r.player}</strong><small
                  >{new Date(r.testedAt).toLocaleDateString()}</small
                ></Table.Cell
              ><Table.Cell
                >{profiles.find(
                  (p) => p.profileId === r.profileId && p.revision === r.profileRevision
                )?.name ?? r.profileId}<small>Revision {r.profileRevision}</small></Table.Cell
              >{#each [r.startup, r.duration, r.forwardSeek && r.backwardSeek, r.audio && r.video] as ok}<Table.Cell
                  >{#if ok}<Check class="ok" />{:else}<X class="fail" />{/if}</Table.Cell
                >{/each}<Table.Cell><Badge variant={variant(r.state)}>{r.state}</Badge></Table.Cell
              ></Table.Row
            >{/each}</Table.Body
        ></Table.Root
      >
    </div>
  </div>
  <Dialog.Root bind:open
    ><Dialog.Content class="sm:max-w-2xl"
      ><Dialog.Header
        ><Dialog.Title>Record a VRChat playback test</Dialog.Title><Dialog.Description
          >Only promote a profile after testing the real platform and player.</Dialog.Description
        ></Dialog.Header
      >
      <div class="two">
        <Field.Field
          ><Field.FieldLabel>Platform</Field.FieldLabel><Select.Root
            type="single"
            bind:value={platform}
            ><Select.Trigger>{platform.toUpperCase()}</Select.Trigger><Select.Content
              ><Select.Group
                ><Select.Item value="pc" label="PC">PC</Select.Item><Select.Item
                  value="quest"
                  label="Quest">Quest</Select.Item
                ></Select.Group
              ></Select.Content
            ></Select.Root
          ></Field.Field
        ><Field.Field
          ><Field.FieldLabel>Player</Field.FieldLabel><Input bind:value={player} /></Field.Field
        ><Field.Field
          ><Field.FieldLabel>Profile revision</Field.FieldLabel><Select.Root
            type="single"
            bind:value={profileKey}
            ><Select.Trigger
              >{profiles.find((p) => `${p.profileId}:${p.revision}` === profileKey)?.name ??
                'Profile'}</Select.Trigger
            ><Select.Content
              ><Select.Group
                >{#each profiles as p}<Select.Item
                    value={`${p.profileId}:${p.revision}`}
                    label={p.name}>{p.name} · r{p.revision}</Select.Item
                  >{/each}</Select.Group
              ></Select.Content
            ></Select.Root
          ></Field.Field
        ><Field.Field
          ><Field.FieldLabel>Conclusion</Field.FieldLabel><Select.Root
            type="single"
            bind:value={resultState}
            ><Select.Trigger>{resultState}</Select.Trigger><Select.Content
              ><Select.Group
                >{#each ['experimental', 'verified', 'broken', 'retired'] as s}<Select.Item
                    value={s}
                    label={s}>{s}</Select.Item
                  >{/each}</Select.Group
              ></Select.Content
            ></Select.Root
          ></Field.Field
        >
      </div>
      <div class="check-grid">
        {#each checks as key}<label
            ><input type="checkbox" bind:checked={passed[key]} /><span
              >{key.replace(/([A-Z])/g, ' $1')}</span
            ></label
          >{/each}
      </div>
      <Field.Field
        ><Field.FieldLabel>Notes</Field.FieldLabel><Input
          bind:value={notes}
          placeholder="Build, URL settings, failure details…"
        /></Field.Field
      ><Dialog.Footer
        ><Button variant="outline" onclick={() => (open = false)}>Cancel</Button><Button
          onclick={() => void save()}>Save evidence</Button
        ></Dialog.Footer
      ></Dialog.Content
    ></Dialog.Root
  ></AppShell
>

<style>
  .page {
    padding: 34px 38px;
  }
  .table {
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
  }
  :global(td strong) {
    font-size: 11px;
  }
  :global(td small) {
    display: block;
    margin-top: 4px;
    color: var(--muted-foreground);
    font-size: 9px;
  }
  :global(.ok),
  :global(.fail) {
    width: 16px;
  }
  :global(.ok) {
    color: var(--success);
  }
  :global(.fail) {
    color: var(--destructive);
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .check-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 7px;
    margin: 15px 0;
  }
  .check-grid label {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 9px;
    text-transform: capitalize;
    font-size: 10px;
  }
  .check-grid input {
    accent-color: var(--primary);
  }
  @media (max-width: 650px) {
    .page {
      padding: 24px 16px;
    }
    .two,
    .check-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
