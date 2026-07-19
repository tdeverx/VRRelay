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

  let method = $state<'jellyfin' | 'recovery'>('jellyfin');
  let username = $state('');
  let password = $state('');
  let pending = $state(false);
  let providerName = $state('Jellyfin');

  onMount(async () => {
    try {
      const status = await api.signInStatus();
      providerName = status.providerName ?? 'Jellyfin';
      if (!status.configured) method = 'recovery';
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
      await api.login(
        method === 'jellyfin' ? { method, username, password } : { method, password }
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
        Sign in with your own Jellyfin account, or use recovery access for administration.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form id="new-login-form" onsubmit={submit}>
        <Field.Group>
          <div class="grid grid-cols-2 gap-2" role="group" aria-label="Sign-in method">
            <Button
              type="button"
              variant={method === 'jellyfin' ? 'default' : 'outline'}
              onclick={() => (method = 'jellyfin')}>{providerName}</Button
            >
            <Button
              type="button"
              variant={method === 'recovery' ? 'default' : 'outline'}
              onclick={() => (method = 'recovery')}>Recovery owner</Button
            >
          </div>
          {#if method === 'jellyfin'}
            <Field.Field>
              <Field.Label for="new-username">Username</Field.Label>
              <Input id="new-username" bind:value={username} autocomplete="username" autofocus />
            </Field.Field>
          {/if}
          <Field.Field>
            <Field.Label for="new-password">
              {method === 'jellyfin' ? `${providerName} password` : 'Recovery password'}
            </Field.Label>
            <Input
              id="new-password"
              type="password"
              bind:value={password}
              autocomplete="current-password"
              autofocus={method === 'recovery'}
            />
            <Field.Description>
              {method === 'jellyfin'
                ? 'Your password is exchanged for a session token and is never stored.'
                : 'Recovery access manages the installation but does not provide a personal catalog.'}
            </Field.Description>
          </Field.Field>
        </Field.Group>
      </form>
    </Card.Content>
    <Card.Footer>
      <Button
        type="submit"
        form="new-login-form"
        disabled={pending || !password || (method === 'jellyfin' && !username)}
      >
        {#if pending}<LoaderCircle data-icon="inline-start" class="animate-spin" />{:else}<LogIn
            data-icon="inline-start"
          />{/if}
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </Card.Footer>
  </Card.Root>
</main>
