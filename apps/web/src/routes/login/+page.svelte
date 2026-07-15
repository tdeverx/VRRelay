<script lang="ts">
  import { goto } from '$app/navigation';
  import { LoaderCircle, LogIn } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import { api } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Field, FieldGroup, FieldLabel } from '$lib/components/ui/field';

  let password = $state('');
  let pending = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    pending = true;
    try {
      await api.login(password);
      await goto('/');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      pending = false;
    }
  }
</script>

<main class="auth-page">
  <section aria-labelledby="login-title">
    <BrandMark />
    <div class="heading">
      <h1 id="login-title">Welcome back</h1>
      <p>Sign in to manage relay sessions, providers, and live ingest.</p>
    </div>
    <form onsubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel for="password">Administrator password</FieldLabel>
          <Input
            id="password"
            type="password"
            bind:value={password}
            autocomplete="current-password"
            autofocus
          />
        </Field>
      </FieldGroup>
      <Button type="submit" size="lg" disabled={pending || !password}>
        {#if pending}<LoaderCircle data-icon="inline-start" class="animate-spin" />{:else}<LogIn
            data-icon="inline-start"
          />{/if}
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
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
    width: min(100%, 400px);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    background: var(--card);
    box-shadow: 0 22px 80px rgb(0 0 0 / 0.32);
  }
  .heading,
  form {
    display: flex;
    flex-direction: column;
  }
  .heading {
    gap: 8px;
    margin: 34px 0 28px;
  }
  form {
    gap: 24px;
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
</style>
