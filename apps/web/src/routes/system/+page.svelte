<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Activity, CheckCircle2, Cpu, Gauge, HardDrive } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import AppShell from '$lib/components/AppShell.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActivityRail from '$lib/components/ActivityRail.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Badge } from '$lib/components/ui/badge';
  import * as Table from '$lib/components/ui/table';
  let health = $state<{
      status: string;
      version: string;
      now: string;
      workers: { active: number; limit: number; queued: number };
    } | null>(null),
    caps = $state<Awaited<ReturnType<typeof api.capabilities>> | null>(null),
    events = $state<Awaited<ReturnType<typeof api.recentEvents>>['items']>([]);
  onMount(async () => {
    try {
      [health, caps, events] = [
        await api.health(),
        await api.capabilities(),
        (await api.recentEvents()).items
      ];
    } catch (e) {
      if (isAuthenticatedError(e)) return goto('/login');
      toast.error(e instanceof Error ? e.message : 'Could not load system state.');
    }
  });
</script>

<AppShell active="system"
  >{#snippet rail()}<ActivityRail {events} />{/snippet}
  <div class="page">
    <PageHeader
      title="System"
      description="Runtime capabilities, encoder capacity, and relay health."
    />
    <div class="cards">
      <article>
        <CheckCircle2 /><strong>{health?.status ?? 'Checking'}</strong><span>Relay service</span>
      </article>
      <article>
        <Cpu /><strong>{health?.workers.active ?? 0} / {health?.workers.limit ?? 0}</strong><span
          >Active encoders</span
        >
      </article>
      <article>
        <Gauge /><strong>{health?.workers.queued ?? 0}</strong><span>Queued workers</span>
      </article>
      <article>
        <HardDrive /><strong>{caps?.encoders.filter((e) => e.available).length ?? 0}</strong><span
          >Available encoders</span
        >
      </article>
    </div>
    <section>
      <h2>FFmpeg capabilities</h2>
      <p>{caps?.ffmpegVersion ?? 'Discovering FFmpeg…'}</p>
      <div class="table">
        <Table.Root
          ><Table.Header
            ><Table.Row
              ><Table.Head>Encoder</Table.Head><Table.Head>Codec</Table.Head><Table.Head
                >Mode</Table.Head
              ><Table.Head>Availability</Table.Head></Table.Row
            ></Table.Header
          ><Table.Body
            >{#each caps?.encoders ?? [] as e}<Table.Row
                ><Table.Cell><code>{e.name}</code></Table.Cell><Table.Cell>{e.codec}</Table.Cell
                ><Table.Cell>{e.hardware ? 'Hardware' : 'Software'}</Table.Cell><Table.Cell
                  ><Badge variant={e.available ? 'success' : 'neutral'}
                    >{e.available ? 'Available' : 'Unavailable'}</Badge
                  >{#if e.reason}<small>{e.reason}</small>{/if}</Table.Cell
                ></Table.Row
              >{/each}</Table.Body
          ></Table.Root
        >
      </div>
    </section>
  </div></AppShell
>

<style>
  .page {
    padding: 34px 38px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 24px;
  }
  .cards article {
    display: grid;
    grid-template-columns: 34px 1fr;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    padding: 16px;
  }
  .cards :global(svg) {
    grid-row: 1/3;
    width: 19px;
    color: var(--primary);
  }
  .cards strong {
    font-size: 17px;
    text-transform: capitalize;
  }
  .cards span,
  section p,
  small {
    color: var(--muted-foreground);
    font-size: 10px;
  }
  section h2 {
    font-size: 15px;
  }
  section p {
    margin: 5px 0 14px;
  }
  .table {
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
  }
  code {
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  small {
    display: block;
    margin-top: 4px;
  }
  @media (max-width: 900px) {
    .cards {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  @media (max-width: 650px) {
    .page {
      padding: 24px 16px;
    }
    .cards {
      grid-template-columns: 1fr;
    }
  }
</style>
