<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Cpu, FlaskConical, Plus, ShieldCheck } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { ProfileRevision } from '@vrrelay/domain';
  import AppShell from '$lib/components/AppShell.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
  import * as Table from '$lib/components/ui/table';
  import { formatBitrate } from '$lib/utils';

  let profiles = $state<ProfileRevision[]>([]);
  onMount(async () => {
    try {
      profiles = (await api.profiles()).items;
    } catch (error) {
      if (isAuthenticatedError(error)) return goto('/login');
      toast.error(error instanceof Error ? error.message : 'Could not load profiles.');
    }
  });
  const variant = (state: ProfileRevision['state']): BadgeVariant =>
    state === 'verified'
      ? 'success'
      : state === 'broken'
        ? 'destructive'
        : state === 'experimental'
          ? 'warning'
          : 'neutral';
</script>

<AppShell active="profiles"
  ><div class="page">
    <PageHeader
      title="Profiles"
      description="Immutable encoding and delivery revisions. Experimental options stay clearly marked."
    >
      {#snippet actions()}<Button href="/profiles/new"><Plus />New revision</Button>{/snippet}
    </PageHeader>
    <div class="cards">
      <article>
        <ShieldCheck /><strong>{profiles.filter((p) => p.state === 'verified').length}</strong><span
          >Verified revisions</span
        >
      </article>
      <article>
        <FlaskConical /><strong>{profiles.filter((p) => p.state === 'experimental').length}</strong
        ><span>Experiments</span>
      </article>
      <article>
        <Cpu /><strong>{new Set(profiles.map((p) => p.video.encoder)).size}</strong><span
          >Encoder paths</span
        >
      </article>
    </div>
    <div class="table">
      <Table.Root
        ><Table.Header
          ><Table.Row
            ><Table.Head>Profile</Table.Head><Table.Head>Platform</Table.Head><Table.Head
              >Video</Table.Head
            ><Table.Head>Audio</Table.Head><Table.Head>Delivery</Table.Head><Table.Head
              >State</Table.Head
            ></Table.Row
          ></Table.Header
        ><Table.Body>
          {#each profiles as profile}<Table.Row
              ><Table.Cell
                ><strong>{profile.name}</strong><small
                  >Revision {profile.revision} · {formatBitrate(profile.video.bitrateKbps)}</small
                ></Table.Cell
              ><Table.Cell>{profile.platform}</Table.Cell><Table.Cell
                >{profile.video.codec.toUpperCase()} · {profile.video.encoder}<small
                  >{profile.video.width}×{profile.video.height} · {profile.video.pixelFormat}</small
                ></Table.Cell
              ><Table.Cell
                >{profile.audio.codec.toUpperCase()} · {profile.audio.channels} ch</Table.Cell
              ><Table.Cell
                >{profile.delivery.method.replace('_', ' ')}<small
                  >{profile.delivery.container} · {profile.delivery.playlistType}</small
                ></Table.Cell
              ><Table.Cell
                ><Badge variant={variant(profile.state)}>{profile.state}</Badge
                >{#if profile.disabledReason}<small>{profile.disabledReason}</small
                  >{/if}</Table.Cell
              ></Table.Row
            >{/each}
        </Table.Body></Table.Root
      >
    </div>
  </div></AppShell
>

<style>
  .page {
    padding: 34px 38px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-bottom: 20px;
  }
  .cards article {
    display: grid;
    grid-template-columns: 35px 1fr;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    padding: 17px;
  }
  .cards :global(svg) {
    grid-row: 1/3;
    width: 20px;
    color: var(--primary);
  }
  .cards strong {
    font-size: 20px;
  }
  .cards span,
  :global(td small) {
    display: block;
    color: var(--muted-foreground);
    font-size: 10px;
  }
  .table {
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
  }
  :global(td strong) {
    font-size: 12px;
  }
  :global(td small) {
    margin-top: 4px;
  }
  @media (max-width: 700px) {
    .page {
      padding: 24px 16px;
    }
    .cards {
      grid-template-columns: 1fr;
    }
  }
</style>
