<script lang="ts">
  import { Badge } from '$lib/new-ui/components/ui/badge';

  let { value }: { value: string } = $props();
  let className = $derived(
    ['active', 'live', 'healthy', 'verified', 'ready', 'ok', 'completed', 'configured'].includes(
      value.toLowerCase()
    )
      ? 'border-success/30 bg-success/10 text-success'
      : ['queued', 'starting', 'experimental', 'draining', 'pending'].includes(value.toLowerCase())
        ? 'border-warning/30 bg-warning/10 text-warning'
        : ['error', 'broken', 'failed', 'unhealthy', 'revoked'].includes(value.toLowerCase())
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : ''
  );
</script>

<Badge variant="outline" class={className}>{value}</Badge>
