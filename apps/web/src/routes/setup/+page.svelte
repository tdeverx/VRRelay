<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { LockKeyhole, LoaderCircle } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import { api } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Field, FieldDescription, FieldGroup, FieldLabel } from '$lib/components/ui/field';
  import { switchUi } from '$lib/new-ui/state.svelte';

  let password = $state('');
  let confirmation = $state('');
  let setupToken = $state('');
  let requiresToken = $state(false);
  let pending = $state(false);
  let invalid = $derived(
    password.length > 0 && (password.length < 12 || password !== confirmation)
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (password.length < 12 || password !== confirmation) return;
    pending = true;
    try {
      await api.setup(password, setupToken || undefined);
      toast.success('Administrator account created.');
      await goto('/login');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Setup failed.');
    } finally {
      pending = false;
    }
  }

  onMount(async () => {
    try {
      requiresToken = (await api.setupStatus()).requiresToken;
    } catch {
      // The form will surface the authoritative server error on submission.
    }
  });
</script>

<main class="auth-page">
  <section aria-labelledby="setup-title">
    <BrandMark />
    <div class="heading">
      <h1 id="setup-title">Secure your relay</h1>
      <p>Create the local administrator password used to manage VRRelay.</p>
    </div>
    <form onsubmit={submit}>
      <FieldGroup>
        {#if requiresToken}
          <Field>
            <FieldLabel for="setup-token">First-run setup token</FieldLabel>
            <Input id="setup-token" type="password" bind:value={setupToken} autocomplete="off" />
            <FieldDescription
              >Enter the value configured as VRRELAY_SETUP_TOKEN on the controller.</FieldDescription
            >
          </Field>
        {/if}
        <Field data-invalid={invalid || undefined}>
          <FieldLabel for="password">Administrator password</FieldLabel>
          <Input
            id="password"
            type="password"
            bind:value={password}
            autocomplete="new-password"
            aria-invalid={invalid}
          />
          <FieldDescription
            >Use at least 12 characters. The password is stored with Argon2id.</FieldDescription
          >
        </Field>
        <Field data-invalid={invalid || undefined}>
          <FieldLabel for="confirmation">Confirm password</FieldLabel>
          <Input
            id="confirmation"
            type="password"
            bind:value={confirmation}
            autocomplete="new-password"
            aria-invalid={invalid}
          />
          {#if confirmation && password !== confirmation}<FieldDescription
              >Passwords do not match.</FieldDescription
            >{/if}
        </Field>
      </FieldGroup>
      <Button
        type="submit"
        size="lg"
        disabled={pending || invalid || password.length < 12 || (requiresToken && !setupToken)}
      >
        {#if pending}<LoaderCircle
            data-icon="inline-start"
            class="animate-spin"
          />{:else}<LockKeyhole data-icon="inline-start" />{/if}
        {pending ? 'Creating…' : 'Create administrator'}
      </Button>
    </form>
    <Button variant="ghost" onclick={() => switchUi('/setup', 'new')}>Try the new interface</Button>
  </section>
</main>

<style>
  .auth-page {
    display: grid;
    min-height: 100vh;
    place-items: center;
    padding: 24px;
    background:
      radial-gradient(
        circle at 50% 0%,
        color-mix(in oklab, var(--accent) 34%, transparent),
        transparent 34%
      ),
      var(--background);
  }
  section {
    width: min(100%, 420px);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    background: var(--card);
    box-shadow: 0 22px 80px rgb(0 0 0 / 0.32);
  }
  .heading {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 34px 0 28px;
  }
  h1,
  p {
    margin: 0;
  }
  h1 {
    font-size: 26px;
    font-weight: 650;
    letter-spacing: -0.03em;
  }
  p {
    color: var(--muted-foreground);
    line-height: 1.55;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
</style>
