<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Activity } from '@lucide/svelte';
  import { portalApi } from '#lib/api';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';

  let username = $state('');
  let password = $state('');
  let providerName = $state('Jellyfin');
  let error = $state('');
  let busy = $state(false);

  onMount(async () => {
    try {
      const status = await portalApi.status();
      if (!status.configured) return goto('/dashboard/settings');
      providerName = status.providerName ?? 'Jellyfin';
      await portalApi.me();
      await goto('/portal');
    } catch {
      // A signed-out user should stay on the login form.
    }
  });

  async function login(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await portalApi.login(username, password);
      await goto('/portal');
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Sign in failed.';
    } finally {
      busy = false;
    }
  }
</script>

<main class="grid min-h-svh place-items-center p-4">
  <Card.Root class="w-full max-w-md">
    <Card.Header>
      <div class="flex items-center gap-2"><Activity class="size-5" /><strong>VRRelay</strong></div>
      <Card.Title>Sign in to {providerName}</Card.Title>
      <Card.Description>
        Use your own Jellyfin account. Your password is exchanged directly and never stored.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form onsubmit={login}>
        <Field.Group>
          <Field.Field>
            <Field.Label for="portal-username">Username</Field.Label>
            <Input id="portal-username" bind:value={username} autocomplete="username" required />
          </Field.Field>
          <Field.Field>
            <Field.Label for="portal-password">Password</Field.Label>
            <Input
              id="portal-password"
              type="password"
              bind:value={password}
              autocomplete="current-password"
              required
            />
            {#if error}<Field.Error>{error}</Field.Error>{/if}
          </Field.Field>
          <Button type="submit" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </Field.Group>
      </form>
    </Card.Content>
    <Card.Footer>
      <Button variant="ghost" href="/dashboard/login">Administrator dashboard</Button>
    </Card.Footer>
  </Card.Root>
</main>
