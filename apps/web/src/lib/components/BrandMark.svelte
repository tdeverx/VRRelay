<script lang="ts">
  let { compact = false }: { compact?: boolean } = $props();
</script>

<span class="brand" aria-label="VRRelay">
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M6 4v24l20-12L6 4Z" />
    <path d="M11 10v12l10-6-10-6Z" />
  </svg>
  {#if !compact}<strong>VRRelay</strong>{/if}
</span>

<style>
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    color: var(--foreground);
    letter-spacing: -0.02em;
  }
  svg {
    width: 28px;
    height: 28px;
    fill: none;
    stroke: var(--primary);
    stroke-width: 1.8;
    stroke-linejoin: round;
  }
  strong {
    font-size: 18px;
    font-weight: 680;
  }
</style>
