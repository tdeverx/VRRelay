<script lang="ts">
  import * as AlertDialog from '#lib/new-ui/components/ui/alert-dialog';
  import * as Alert from '#lib/new-ui/components/ui/alert';
  import { Button } from '#lib/new-ui/components/ui/button';

  let {
    open = $bindable(false),
    title,
    description,
    confirmLabel,
    onConfirm,
    onOpenChange
  }: {
    open?: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
    onOpenChange?: (open: boolean) => void;
  } = $props();

  let pending = $state(false);
  let error = $state('');

  function setOpen(value: boolean) {
    if (pending) return;
    open = value;
    onOpenChange?.(value);
    if (!value) error = '';
  }

  async function confirm() {
    pending = true;
    error = '';
    try {
      await onConfirm();
      open = false;
      onOpenChange?.(false);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'The action could not be completed.';
    } finally {
      pending = false;
    }
  }
</script>

<AlertDialog.Root {open} onOpenChange={setOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{title}</AlertDialog.Title>
      <AlertDialog.Description>{description}</AlertDialog.Description>
    </AlertDialog.Header>
    {#if error}
      <Alert.Root variant="destructive" aria-live="polite">
        <Alert.Title>Action failed</Alert.Title>
        <Alert.Description>{error}</Alert.Description>
      </Alert.Root>
    {/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={pending}>Cancel</AlertDialog.Cancel>
      <Button variant="destructive" disabled={pending} onclick={confirm}>
        {pending ? 'Working…' : confirmLabel}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
