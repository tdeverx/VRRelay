<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { LockKeyhole, LoaderCircle } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { api } from '#lib/api';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import { Skeleton } from '#lib/new-ui/components/ui/skeleton';
  import { adminRoute } from '#lib/new-ui/state.svelte';

  let password = $state('');
  let confirmation = $state('');
  let setupToken = $state('');
  let requiresToken = $state(false);
  let pending = $state(false);
  let loading = $state(true);
  let invalid = $derived(
    password.length > 0 && (password.length < 12 || password !== confirmation)
  );

  onMount(async () => {
    try {
      requiresToken = (await api.setupStatus()).requiresToken;
    } catch {
      // Submission presents the authoritative connection error.
    } finally {
      loading = false;
    }
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (password.length < 12 || password !== confirmation) return;
    pending = true;
    try {
      await api.setup(password, setupToken || undefined);
      toast.success('Administrator account created.');
      await goto(adminRoute(page.url.pathname, '/login'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Setup failed.');
    } finally {
      pending = false;
    }
  }
</script>

<main class="grid min-h-svh place-items-center p-4">
  <Card.Root class="w-full max-w-md">
    <Card.Header>
      <Card.Title><h1>Secure your relay</h1></Card.Title>
      <Card.Description
        >Create the local administrator password used to manage VRRelay.</Card.Description
      >
    </Card.Header>
    <Card.Content>
      {#if loading}
        <div class="space-y-5" role="status" aria-live="polite">
          <span class="sr-only">Loading setup requirements</span>
          {#each Array(3) as _}
            <div class="space-y-2" aria-hidden="true">
              <Skeleton class="h-4 w-32" />
              <Skeleton class="h-9 w-full" />
            </div>
          {/each}
        </div>
      {:else}
        <form id="new-setup-form" onsubmit={submit}>
          <Field.Group>
            {#if requiresToken}
              <Field.Field>
                <Field.Label for="new-setup-token">First-run setup token</Field.Label>
                <Input
                  id="new-setup-token"
                  type="password"
                  bind:value={setupToken}
                  autocomplete="off"
                />
                <Field.Description>
                  Enter the value configured as VRRELAY_SETUP_TOKEN on the controller.
                </Field.Description>
              </Field.Field>
            {/if}
            <Field.Field data-invalid={invalid || undefined}>
              <Field.Label for="new-setup-password">Administrator password</Field.Label>
              <Input
                id="new-setup-password"
                type="password"
                bind:value={password}
                autocomplete="new-password"
                aria-invalid={invalid}
              />
              <Field.Description
                >Use at least 12 characters. The password is stored with Argon2id.</Field.Description
              >
            </Field.Field>
            <Field.Field data-invalid={invalid || undefined}>
              <Field.Label for="new-confirmation">Confirm password</Field.Label>
              <Input
                id="new-confirmation"
                type="password"
                bind:value={confirmation}
                autocomplete="new-password"
                aria-invalid={invalid}
              />
              {#if confirmation && password !== confirmation}
                <Field.Description>Passwords do not match.</Field.Description>
              {/if}
            </Field.Field>
          </Field.Group>
        </form>
      {/if}
    </Card.Content>
    <Card.Footer>
      <Button
        type="submit"
        form="new-setup-form"
        disabled={loading ||
          pending ||
          invalid ||
          password.length < 12 ||
          (requiresToken && !setupToken)}
      >
        {#if pending}<LoaderCircle
            data-icon="inline-start"
            class="animate-spin"
          />{:else}<LockKeyhole data-icon="inline-start" />{/if}
        {pending ? 'Creating…' : 'Create administrator'}
      </Button>
    </Card.Footer>
  </Card.Root>
</main>
