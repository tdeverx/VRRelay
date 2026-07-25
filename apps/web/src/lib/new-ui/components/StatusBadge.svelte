<script lang="ts">
  import { Badge } from '#lib/new-ui/components/ui/badge';

  let { value }: { value: string } = $props();
  let normalized = $derived(value.toLowerCase());
  let className = $derived(
    [
      'active',
      'streaming',
      'live',
      'healthy',
      'verified',
      'ready',
      'ok',
      'completed',
      'complete',
      'configured',
      'online',
      'running',
      'succeeded',
      'available',
      'buffered',
      'connected'
    ].includes(normalized)
      ? 'border-success/30 bg-success/10 text-success'
      : [
            'queued',
            'starting',
            'experimental',
            'draining',
            'pending',
            'joining',
            'degraded',
            'reconnecting',
            'switching',
            'catching_up'
          ].includes(normalized)
        ? 'border-warning/30 bg-warning/10 text-warning'
        : ['error', 'broken', 'failed', 'unhealthy', 'revoked', 'unavailable'].includes(normalized)
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : ['idle', 'stopped', 'cancelled', 'offline', 'retired', 'waiting'].includes(normalized)
            ? 'border-muted-foreground/30 bg-muted text-muted-foreground'
            : ''
  );
</script>

<Badge variant="outline" class={className}>{value}</Badge>
