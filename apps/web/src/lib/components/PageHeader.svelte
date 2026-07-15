<script lang="ts">
  import type { Snippet } from 'svelte';
  let { title, description, actions }: { title: string; description: string; actions?: Snippet } =
    $props();
</script>

<header class="page-header">
  <div>
    <h1>{title}</h1>
    <p>{description}</p>
  </div>
  {#if actions}<div>{@render actions()}</div>{/if}
</header>

<style>
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 26px;
  }
  .page-header h1 {
    font-size: 27px;
    letter-spacing: -0.025em;
  }
  .page-header p {
    margin-top: 5px;
    color: var(--muted-foreground);
    font-size: 13px;
  }
  @media (max-width: 600px) {
    .page-header {
      flex-direction: column;
    }
  }
</style>
