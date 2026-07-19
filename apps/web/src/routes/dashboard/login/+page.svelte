<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { LoaderCircle, LogIn } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { api } from '#lib/api';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import { adminRoute } from '#lib/new-ui/state.svelte';

  let username = $state('');
  let password = $state('');
  let pending = $state(false);
  let providerName = $state('Jellyfin');

  onMount(async () => {
    try {
      const status = await api.signInStatus();
      providerName = status.providerName ?? 'Jellyfin';
      await api.me();
      await goto('/dashboard');
    } catch {
      // Signed-out visitors stay on this page.
    }
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    pending = true;
    try {
      const loginUsername = username.trim();
      await api.login(
        loginUsername
          ? { method: 'jellyfin', username: loginUsername, password }
          : { method: 'recovery', password }
      );
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
        Sign in with your {providerName} account.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form id="new-login-form" onsubmit={submit}>
        <Field.Group>
          <Field.Field>
            <Field.Label for="new-username">Username</Field.Label>
            <Input id="new-username" bind:value={username} autocomplete="username" autofocus />
          </Field.Field>
          <Field.Field>
            <Field.Label for="new-password">Password</Field.Label>
            <Input
              id="new-password"
              type="password"
              bind:value={password}
              autocomplete="current-password"
            />
            <Field.Description>
              Your password is exchanged for a session token and is never stored.
            </Field.Description>
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
