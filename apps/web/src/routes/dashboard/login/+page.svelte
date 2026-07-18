<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { LoaderCircle, LogIn } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { api } from '$lib/api';
  import { Button } from '$lib/new-ui/components/ui/button';
  import * as Card from '$lib/new-ui/components/ui/card';
  import * as Field from '$lib/new-ui/components/ui/field';
  import { Input } from '$lib/new-ui/components/ui/input';
  import { adminRoute } from '$lib/new-ui/state.svelte';

  let password = $state('');
  let pending = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    pending = true;
    try {
      await api.login(password);
      await goto(adminRoute(page.url.pathname));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      pending = false;
    }
  }
</script>

<main class="grid min-h-svh place-items-center p-4">
  <Card.Root class="w-full max-w-md">
    <Card.Header>
      <Card.Title><h1>Welcome back</h1></Card.Title>
      <Card.Description>
        Sign in to manage relay sessions, providers, and live ingest.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form id="new-login-form" onsubmit={submit}>
        <Field.Group>
          <Field.Field>
            <Field.Label for="new-password">Administrator password</Field.Label>
            <Input
              id="new-password"
              type="password"
              bind:value={password}
              autocomplete="current-password"
              autofocus
            />
          </Field.Field>
        </Field.Group>
      </form>
    </Card.Content>
    <Card.Footer>
      <Button type="submit" form="new-login-form" disabled={pending || !password}>
        {#if pending}<LoaderCircle data-icon="inline-start" class="animate-spin" />{:else}<LogIn
            data-icon="inline-start"
          />{/if}
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </Card.Footer>
  </Card.Root>
</main>
