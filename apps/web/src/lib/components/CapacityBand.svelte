<script lang="ts">
  import { Cpu, Database, Gauge, RadioTower } from '@lucide/svelte';
  let {
    activeWorkers,
    maxWorkers,
    ffmpegVersion
  }: { activeWorkers: number; maxWorkers: number; ffmpegVersion: string } = $props();
</script>

<div class="capacity-band">
  <section>
    <Cpu />
    <div>
      <span>CPU</span><strong>{Math.round((activeWorkers / Math.max(1, maxWorkers)) * 100)}%</strong
      >
    </div>
  </section>
  <section>
    <Gauge />
    <div><span>Encoder workers</span><strong>{activeWorkers} / {maxWorkers}</strong></div>
  </section>
  <section>
    <Database />
    <div><span>Segment cache</span><strong>Temporary</strong></div>
  </section>
  <section>
    <RadioTower />
    <div><span>FFmpeg</span><strong>{ffmpegVersion.split(' ').slice(0, 3).join(' ')}</strong></div>
  </section>
</div>

<style>
  .capacity-band {
    display: grid;
    height: 100%;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  section {
    display: flex;
    align-items: center;
    gap: 16px;
    border-right: 1px solid var(--border);
    padding: 24px 28px;
  }
  section:last-child {
    border-right: 0;
  }
  section :global(svg) {
    width: 24px;
    height: 24px;
    color: var(--muted-foreground);
    stroke-width: 1.5;
  }
  section div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
  }
  span {
    color: var(--muted-foreground);
    font-size: 12px;
  }
  strong {
    overflow: hidden;
    font-size: 20px;
    font-weight: 570;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
