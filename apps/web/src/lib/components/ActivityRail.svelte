<script lang="ts">
  import { Antenna, Database, Radio, Users, Zap } from '@lucide/svelte';
  import type { Component } from 'svelte';

  let {
    events
  }: {
    events: Array<{
      id: string;
      type: string;
      timestamp: string;
      payload: Record<string, unknown>;
    }>;
  } = $props();

  const icons: Record<string, Component> = {
    'worker.started': Zap,
    'worker.completed': Zap,
    'cache.hit': Database,
    'cache.evicted': Database,
    'viewer.joined': Users,
    'viewer.left': Users,
    'live.publisher.connected': Antenna,
    'live.publisher.disconnected': Radio
  };

  function title(type: string): string {
    return type
      .split('.')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
</script>

<section aria-labelledby="activity-title" class="activity-rail">
  <h2 id="activity-title">Recent activity</h2>
  <div class="event-list">
    {#if events.length === 0}
      <p class="empty-copy">Encoder and viewer activity will appear here.</p>
    {:else}
      {#each events.slice(0, 9) as event (event.id)}
        {@const Icon = icons[event.type] ?? Radio}
        <article>
          <Icon />
          <div>
            <strong>{title(event.type)}</strong>
            <span>{String(event.payload.name ?? event.payload.segment ?? 'VRRelay')}</span>
          </div>
          <time datetime={event.timestamp}
            >{new Date(event.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            })}</time
          >
        </article>
      {/each}
    {/if}
  </div>
</section>

<style>
  .activity-rail {
    padding: 28px 24px;
  }
  h2 {
    margin: 0 0 19px;
    font-size: 16px;
    font-weight: 620;
  }
  .event-list {
    display: flex;
    flex-direction: column;
  }
  article {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) auto;
    gap: 12px;
    align-items: start;
    border-bottom: 1px solid var(--border);
    padding: 14px 0;
  }
  article :global(svg) {
    width: 20px;
    height: 20px;
    margin-top: 2px;
    color: var(--muted-foreground);
    stroke-width: 1.6;
  }
  article div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }
  strong {
    overflow: hidden;
    font-size: 12px;
    font-weight: 590;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  span,
  time,
  .empty-copy {
    color: var(--muted-foreground);
    font-size: 11px;
  }
  time {
    margin-top: 2px;
  }
</style>
