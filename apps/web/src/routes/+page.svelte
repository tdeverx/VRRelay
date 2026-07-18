<script lang="ts">
  import { LoaderCircle } from '@lucide/svelte';
</script>

<main class="grid min-h-svh place-items-center p-4" aria-live="polite">
  <div class="text-muted-foreground flex items-center gap-2 text-sm">
    <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
    Opening VRRelay…
  </div>
</main>
