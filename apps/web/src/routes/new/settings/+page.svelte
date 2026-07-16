<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Copy, LogOut, RefreshCw, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type {
    PersonalAccessToken,
    ProfileRevision,
    PublicProviderConnection,
    Scope
  } from '@vrrelay/domain';
  import type { PortalConfigurationRequest, RuntimeConfiguration } from '@vrrelay/contracts';
  import { api, isAuthenticatedError } from '$lib/api';
  import { adminRoute } from '$lib/new-ui/state.svelte';
  import PageHeader from '$lib/new-ui/components/PageHeader.svelte';
  import StatusBadge from '$lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '$lib/new-ui/components/ui/button';
  import * as Alert from '$lib/new-ui/components/ui/alert';
  import * as AlertDialog from '$lib/new-ui/components/ui/alert-dialog';
  import * as Card from '$lib/new-ui/components/ui/card';
  import * as Field from '$lib/new-ui/components/ui/field';
  import { Input } from '$lib/new-ui/components/ui/input';
  import * as Select from '$lib/new-ui/components/ui/select';
  import { Switch } from '$lib/new-ui/components/ui/switch';
  import * as Tabs from '$lib/new-ui/components/ui/tabs';

  type Section = 'connections' | 'tokens' | 'network' | 'runtime';
  let section = $state<Section>('connections');
  let providers = $state<PublicProviderConnection[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let tokens = $state<Array<Omit<PersonalAccessToken, 'tokenHash'>>>([]);
  let runtime = $state<Awaited<ReturnType<typeof api.runtimeConfiguration>> | null>(null);
  let runtimeDraft = $state<RuntimeConfiguration | null>(null);
  let trustedProxyCidrs = $state('');
  let name = $state('Jellyfin');
  let baseUrl = $state('http://127.0.0.1:8096/jellyfin');
  let allowPublicHttp = $state(false);
  let portalProviderId = $state('');
  let portalConfigured = $state(false);
  let defaultProfileId = $state('');
  let allowedProfileIds = $state<string[]>([]);
  let tokenName = $state('Unity client');
  let newToken = $state('');
  let scopeState = $state<Record<Exclude<Scope, 'admin'>, boolean>>({
    'catalog:read': true,
    'sessions:create': true,
    'sessions:read': true,
    'sessions:control': true
  });
  let pendingProvider = $state<PublicProviderConnection | null>(null);
  let busy = $state(false);
  let validatingProviderId = $state('');
  let runtimeValidated = $state(false);

  let scopes = $derived(
    Object.entries(scopeState)
      .filter(([, enabled]) => enabled)
      .map(([scope]) => scope) as Scope[]
  );
  let profileChoices = $derived.by(() => {
    const latest = new Map<string, ProfileRevision>();
    for (const profile of profiles) {
      if (!latest.has(profile.profileId)) latest.set(profile.profileId, profile);
    }
    return [...latest.values()];
  });

  onMount(async () => {
    try {
      const [providerResult, profileResult, portalResult, tokenResult, runtimeResult] =
        await Promise.all([
          api.providers(),
          api.profiles(),
          api.portalConfiguration(),
          api.tokens(),
          api.runtimeConfiguration()
        ]);
      providers = providerResult.items;
      profiles = profileResult.items;
      if (portalResult.configuration) {
        portalProviderId = portalResult.configuration.providerId;
        defaultProfileId = portalResult.configuration.defaultProfileId;
        allowedProfileIds = portalResult.configuration.allowedProfileIds;
      } else {
        portalProviderId =
          providerResult.items.find((provider) => provider.authMode === 'delegated')?.id ?? '';
        defaultProfileId = profileChoices[0]?.profileId ?? '';
        allowedProfileIds = defaultProfileId ? [defaultProfileId] : [];
      }
      tokens = tokenResult.items;
      runtime = runtimeResult;
      runtimeDraft = structuredClone(runtimeResult.configuration);
      trustedProxyCidrs = runtimeResult.configuration.trustedProxyCidrs.join(', ');
      portalConfigured = Boolean(portalResult.configuration);
      if (!portalConfigured && portalProviderId) {
        try {
          if (await enablePortal(portalProviderId))
            toast.success('User portal enabled with the default profile.');
        } catch (reason) {
          toast.error(
            reason instanceof Error ? reason.message : 'Could not enable the user portal.'
          );
        }
      }
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(adminRoute(page.url.pathname, '/login'));
      toast.error(reason instanceof Error ? reason.message : 'Could not load settings.');
    }
  });

  async function connect() {
    busy = true;
    try {
      const provider = await api.createProvider({
        type: 'jellyfin',
        name,
        baseUrl,
        authMode: 'delegated',
        allowPublicHttp
      });
      providers = [provider, ...providers];
      if (!portalConfigured) {
        portalProviderId = provider.id;
        try {
          if (await enablePortal(provider.id)) {
            toast.success('Jellyfin endpoint added and user portal enabled.');
          } else {
            toast.warning('Endpoint added. Create a profile before enabling the user portal.');
          }
        } catch (reason) {
          toast.warning(
            reason instanceof Error
              ? `Endpoint added, but the user portal could not be enabled: ${reason.message}`
              : 'Endpoint added, but the user portal could not be enabled.'
          );
        }
      } else {
        toast.success('Jellyfin endpoint added.');
      }
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Connection failed.');
    } finally {
      busy = false;
    }
  }

  function setProfileAllowed(profileId: string, allowed: boolean) {
    allowedProfileIds = allowed
      ? [...new Set([...allowedProfileIds, profileId])]
      : allowedProfileIds.filter((id) => id !== profileId);
    if (!allowedProfileIds.includes(defaultProfileId))
      defaultProfileId = allowedProfileIds[0] ?? '';
  }

  async function enablePortal(providerId: string): Promise<boolean> {
    const preferredProfileId =
      defaultProfileId ||
      profileChoices.find((profile) => profile.delivery.playlistType === 'vod')?.profileId ||
      profileChoices[0]?.profileId ||
      '';
    if (!preferredProfileId) return false;
    defaultProfileId = preferredProfileId;
    allowedProfileIds = allowedProfileIds.includes(preferredProfileId)
      ? allowedProfileIds
      : [...new Set([preferredProfileId, ...allowedProfileIds])];
    await api.updatePortalConfiguration({
      providerId,
      defaultProfileId,
      allowedProfileIds
    });
    portalConfigured = true;
    return true;
  }

  async function savePortalConfiguration() {
    if (!portalProviderId || !defaultProfileId || allowedProfileIds.length === 0) return;
    busy = true;
    try {
      const configuration: PortalConfigurationRequest = {
        providerId: portalProviderId,
        defaultProfileId,
        allowedProfileIds
      };
      await api.updatePortalConfiguration(configuration);
      portalConfigured = true;
      toast.success('User portal configuration saved.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not save the user portal.');
    } finally {
      busy = false;
    }
  }

  async function validateProvider(id: string) {
    validatingProviderId = id;
    try {
      await api.validateProvider(id);
      providers = (await api.providers()).items;
      toast.success('Jellyfin connection is healthy.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Validation failed.');
    } finally {
      validatingProviderId = '';
    }
  }

  async function removeProvider() {
    if (!pendingProvider) return;
    busy = true;
    try {
      await api.deleteProvider(pendingProvider.id);
      providers = providers.filter((provider) => provider.id !== pendingProvider?.id);
      pendingProvider = null;
      toast.success('Connection removed.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not remove connection.');
    } finally {
      busy = false;
    }
  }

  async function createToken() {
    try {
      const result = await api.createToken({ name: tokenName, scopes, expiresAt: null });
      newToken = result.token;
      const { token: _token, ...record } = result;
      tokens = [record, ...tokens];
      toast.success('Personal token created.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not create token.');
    }
  }

  async function revokeToken(id: string) {
    try {
      await api.revokeToken(id);
      tokens = tokens.map((token) =>
        token.id === id ? { ...token, revokedAt: new Date().toISOString() } : token
      );
      toast.success('Token revoked.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not revoke token.');
    }
  }

  function runtimeRequest(): RuntimeConfiguration | null {
    if (!runtimeDraft) return null;
    return {
      ...runtimeDraft,
      trustedProxyCidrs: trustedProxyCidrs
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    };
  }

  async function validateRuntime() {
    const request = runtimeRequest();
    if (!request) return;
    busy = true;
    try {
      const result = await api.validateRuntimeConfiguration(request);
      runtimeDraft = result.configuration;
      trustedProxyCidrs = result.configuration.trustedProxyCidrs.join(', ');
      runtimeValidated = true;
      toast.success('Configuration is valid.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Validation failed.');
    } finally {
      busy = false;
    }
  }

  async function saveRuntime() {
    const request = runtimeRequest();
    if (!request || !runtime?.writable) return;
    busy = true;
    try {
      runtime = await api.updateRuntimeConfiguration(request);
      runtimeDraft = structuredClone(runtime.configuration);
      trustedProxyCidrs = runtime.configuration.trustedProxyCidrs.join(', ');
      runtimeValidated = true;
      toast.success('Configuration saved.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not save configuration.');
    } finally {
      busy = false;
    }
  }

  async function restartRuntime() {
    if (!runtime?.restartSupported) return;
    busy = true;
    try {
      await api.restartRuntime();
      toast.success('Relay restart requested.');
      window.location.href = adminRoute(page.url.pathname);
    } catch (reason) {
      busy = false;
      toast.error(reason instanceof Error ? reason.message : 'Could not restart relay.');
    }
  }

  async function logout() {
    await api.logout();
    await goto(adminRoute(page.url.pathname, '/login'));
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Settings"
    description="Provider credentials, transport policy and scoped client access."
    >{#snippet actions()}<Button variant="outline" onclick={logout}
        ><LogOut data-icon="inline-start" />Sign out</Button
      >{/snippet}</PageHeader
  >
  <div class="md:hidden">
    <Select.Root
      type="single"
      value={section}
      onValueChange={(value) => value && (section = value as Section)}
      ><Select.Trigger class="w-full"
        >{section === 'connections'
          ? 'Connections'
          : section === 'tokens'
            ? 'Access Tokens'
            : section === 'network'
              ? 'Network'
              : 'Runtime'}</Select.Trigger
      ><Select.Content
        ><Select.Group
          ><Select.Item value="connections">Connections</Select.Item><Select.Item value="tokens"
            >Access Tokens</Select.Item
          ><Select.Item value="network">Network</Select.Item><Select.Item value="runtime"
            >Runtime</Select.Item
          ></Select.Group
        ></Select.Content
      ></Select.Root
    >
  </div>
  <Tabs.Root value={section} onValueChange={(value) => (section = value as Section)}>
    <Tabs.List class="hidden md:flex"
      ><Tabs.Trigger value="connections">Connections</Tabs.Trigger><Tabs.Trigger value="tokens"
        >Access Tokens</Tabs.Trigger
      ><Tabs.Trigger value="network">Network</Tabs.Trigger><Tabs.Trigger value="runtime"
        >Runtime</Tabs.Trigger
      ></Tabs.List
    >

    <Tabs.Content value="connections" class={section === 'connections' ? '' : 'max-md:hidden'}>
      <div class="grid gap-4 xl:grid-cols-2">
        <Card.Root>
          <Card.Header>
            <Card.Title>Jellyfin endpoint</Card.Title>
            <Card.Description>
              Users sign in with their own Jellyfin credentials. VRRelay never stores their
              passwords.
            </Card.Description>
          </Card.Header>
          <Card.Content class="space-y-3">
            {#each providers as provider}
              <div class="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                <StatusBadge
                  value={provider.authMode === 'delegated'
                    ? 'configured'
                    : provider.healthy
                      ? 'healthy'
                      : 'unhealthy'}
                />
                <div class="min-w-0 flex-1">
                  <strong class="block">{provider.name}</strong>
                  <span class="text-muted-foreground block truncate text-xs">
                    {provider.baseUrl} · {provider.authMode === 'delegated'
                      ? 'Per-user login'
                      : 'Administrator credential'}
                  </span>
                </div>
                {#if provider.authMode !== 'delegated'}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Revalidate ${provider.name}`}
                    disabled={validatingProviderId === provider.id}
                    onclick={() => validateProvider(provider.id)}
                  >
                    <RefreshCw class={validatingProviderId === provider.id ? 'animate-spin' : ''} />
                  </Button>
                {/if}
                <Button
                  variant="destructive"
                  size="icon-sm"
                  aria-label={`Remove ${provider.name}`}
                  onclick={() => (pendingProvider = provider)}><Trash2 /></Button
                >
              </div>
            {:else}
              <p class="text-muted-foreground text-sm">No Jellyfin endpoint is configured.</p>
            {/each}
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Add endpoint</Card.Title>
            <Card.Description>No administrator Jellyfin credential is required.</Card.Description>
          </Card.Header>
          <Card.Content>
            <Field.Group>
              <Field.Field>
                <Field.Label for="connection-name">Connection name</Field.Label>
                <Input id="connection-name" bind:value={name} />
              </Field.Field>
              <Field.Field>
                <Field.Label for="connection-url">Jellyfin URL</Field.Label>
                <Input id="connection-url" type="url" bind:value={baseUrl} />
              </Field.Field>
              <label
                class="flex items-center justify-between rounded-lg border p-3"
                for="public-http"
              >
                <span class="text-sm">Allow public HTTP</span>
                <Switch id="public-http" bind:checked={allowPublicHttp} />
              </label>
              <Button disabled={busy || !name || !baseUrl} onclick={connect}>Add endpoint</Button>
            </Field.Group>
          </Card.Content>
        </Card.Root>

        <Card.Root class="xl:col-span-2">
          <Card.Header>
            <Card.Title>User access</Card.Title>
            <Card.Description>
              Choose the endpoint, default profile, and profiles users may select.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <Field.Group>
              <Field.Field>
                <Field.Label>Portal endpoint</Field.Label>
                <Select.Root type="single" bind:value={portalProviderId}>
                  <Select.Trigger class="w-full">
                    {providers.find((provider) => provider.id === portalProviderId)?.name ??
                      'Select endpoint'}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Group>
                      {#each providers.filter((provider) => provider.authMode === 'delegated') as provider}
                        <Select.Item value={provider.id}>{provider.name}</Select.Item>
                      {/each}
                    </Select.Group>
                  </Select.Content>
                </Select.Root>
              </Field.Field>
              <Field.Field>
                <Field.Label>Default profile</Field.Label>
                <Select.Root type="single" bind:value={defaultProfileId}>
                  <Select.Trigger class="w-full">
                    {profileChoices.find((profile) => profile.profileId === defaultProfileId)
                      ?.name ?? 'Select profile'}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Group>
                      {#each profileChoices.filter( (profile) => allowedProfileIds.includes(profile.profileId) ) as profile}
                        <Select.Item value={profile.profileId}>{profile.name}</Select.Item>
                      {/each}
                    </Select.Group>
                  </Select.Content>
                </Select.Root>
              </Field.Field>
              <Field.Field>
                <Field.Label>Selectable profiles</Field.Label>
                <div class="grid gap-2 md:grid-cols-2">
                  {#each profileChoices as profile}
                    <label
                      class="flex items-center justify-between rounded-lg border p-3"
                      for={`portal-profile-${profile.profileId}`}
                    >
                      <span class="text-sm">{profile.name}</span>
                      <Switch
                        id={`portal-profile-${profile.profileId}`}
                        checked={allowedProfileIds.includes(profile.profileId)}
                        onCheckedChange={(checked) => setProfileAllowed(profile.profileId, checked)}
                      />
                    </label>
                  {/each}
                </div>
              </Field.Field>
              <Button
                disabled={busy ||
                  !portalProviderId ||
                  !defaultProfileId ||
                  allowedProfileIds.length === 0}
                onclick={savePortalConfiguration}>Save user access</Button
              >
            </Field.Group>
          </Card.Content>
        </Card.Root>
      </div>
    </Tabs.Content>

    <Tabs.Content value="tokens" class={section === 'tokens' ? '' : 'max-md:hidden'}
      ><div class="grid gap-4 xl:grid-cols-2">
        <Card.Root
          ><Card.Header
            ><Card.Title>Create access token</Card.Title><Card.Description
              >Tokens are shown once. Grant only the scopes the client needs.</Card.Description
            ></Card.Header
          ><Card.Content
            ><Field.Group
              ><Field.Field
                ><Field.Label for="token-name">Token name</Field.Label><Input
                  id="token-name"
                  bind:value={tokenName}
                /></Field.Field
              >{#each Object.keys(scopeState) as scope}<label
                  class="flex items-center justify-between rounded-lg border p-3"
                  for={`scope-${scope}`}
                  ><span class="text-sm">{scope}</span><Switch
                    id={`scope-${scope}`}
                    checked={scopeState[scope as keyof typeof scopeState]}
                    onCheckedChange={(checked) =>
                      (scopeState = { ...scopeState, [scope]: checked })}
                  /></label
                >{/each}<Button disabled={!tokenName || scopes.length === 0} onclick={createToken}
                >Create token</Button
              ></Field.Group
            ></Card.Content
          ></Card.Root
        ><Card.Root
          ><Card.Header><Card.Title>Access tokens</Card.Title></Card.Header><Card.Content
            class="space-y-3"
            >{#if newToken}<Alert.Root
                ><Alert.Title>Copy this token now</Alert.Title><Alert.Description
                  class="break-all font-mono">{newToken}</Alert.Description
                ><Alert.Action
                  ><Button
                    variant="outline"
                    size="sm"
                    onclick={() => navigator.clipboard.writeText(newToken)}
                    ><Copy data-icon="inline-start" />Copy</Button
                  ></Alert.Action
                ></Alert.Root
              >{/if}{#each tokens as token}<div
                class="flex items-center gap-3 rounded-lg border p-3"
              >
                <div class="min-w-0 flex-1">
                  <strong class="block">{token.name}</strong><span
                    class="text-muted-foreground text-xs">{token.scopes.join(', ')}</span
                  >
                </div>
                <StatusBadge
                  value={token.revokedAt ? 'revoked' : 'active'}
                />{#if !token.revokedAt}<Button
                    variant="destructive"
                    size="sm"
                    onclick={() => revokeToken(token.id)}>Revoke</Button
                  >{/if}
              </div>{/each}</Card.Content
          ></Card.Root
        >
      </div></Tabs.Content
    >

    <Tabs.Content value="network" class={section === 'network' ? '' : 'max-md:hidden'}
      >{#if runtimeDraft}<Card.Root
          ><Card.Header
            ><Card.Title>Network endpoints</Card.Title><Card.Description
              >Controller, admin, playback and proxy trust settings.</Card.Description
            ></Card.Header
          ><Card.Content
            ><Field.Group class="grid md:grid-cols-2"
              ><Field.Field
                ><Field.Label for="listen-address">Listen address</Field.Label><Input
                  id="listen-address"
                  bind:value={runtimeDraft.listenAddr}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ><Field.Field
                ><Field.Label for="agent-address">Agent listen address</Field.Label><Input
                  id="agent-address"
                  bind:value={runtimeDraft.agentListenAddr}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ><Field.Field
                ><Field.Label for="public-url">Public URL</Field.Label><Input
                  id="public-url"
                  type="url"
                  bind:value={runtimeDraft.publicUrl}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ><Field.Field
                ><Field.Label for="admin-url">Admin URL</Field.Label><Input
                  id="admin-url"
                  type="url"
                  bind:value={runtimeDraft.adminUrl}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ><Field.Field
                ><Field.Label for="playback-url">Playback URL</Field.Label><Input
                  id="playback-url"
                  type="url"
                  bind:value={runtimeDraft.playbackUrl}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ><Field.Field
                ><Field.Label for="trusted-proxies">Trusted proxy CIDRs</Field.Label><Input
                  id="trusted-proxies"
                  bind:value={trustedProxyCidrs}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ></Field.Group
            ></Card.Content
          >{#if runtime && !runtime.writable}<Card.Footer
              ><Alert.Root class="w-full"
                ><Alert.Title>Read-only deployment configuration</Alert.Title><Alert.Description
                  >These values are controlled by the deployment environment and cannot be changed
                  here.</Alert.Description
                ></Alert.Root
              ></Card.Footer
            >{/if}<Card.Footer class="justify-end gap-2"
            ><Button
              variant="outline"
              disabled={busy || !runtime?.writable}
              onclick={validateRuntime}>Validate</Button
            ><Button
              disabled={busy || !runtime?.writable || !runtimeValidated}
              onclick={saveRuntime}>Save network settings</Button
            ></Card.Footer
          ></Card.Root
        >{/if}</Tabs.Content
    >

    <Tabs.Content value="runtime" class={section === 'runtime' ? '' : 'max-md:hidden'}
      >{#if runtimeDraft}<Card.Root
          ><Card.Header
            ><Card.Title>Runtime capacity</Card.Title><Card.Description
              >Changes are validated before being persisted.</Card.Description
            ></Card.Header
          ><Card.Content
            ><Field.Group class="grid md:grid-cols-2"
              ><Field.Field
                ><Field.Label for="node-name">Node name</Field.Label><Input
                  id="node-name"
                  bind:value={runtimeDraft.nodeName}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ><Field.Field
                ><Field.Label for="node-region">Node region</Field.Label><Input
                  id="node-region"
                  bind:value={runtimeDraft.nodeRegion}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ><Field.Field
                ><Field.Label for="max-workers">Maximum workers</Field.Label><Input
                  id="max-workers"
                  type="number"
                  min="1"
                  max="32"
                  bind:value={runtimeDraft.maxWorkers}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ><Field.Field
                ><Field.Label for="cache-limit">Cache limit (bytes)</Field.Label><Input
                  id="cache-limit"
                  type="number"
                  min="1"
                  bind:value={runtimeDraft.cacheLimitBytes}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ><Field.Field
                ><Field.Label for="cache-ttl">Cache TTL (ms)</Field.Label><Input
                  id="cache-ttl"
                  type="number"
                  min="1000"
                  bind:value={runtimeDraft.cacheTtlMs}
                  disabled={!runtime?.writable}
                  oninput={() => (runtimeValidated = false)}
                /></Field.Field
              ></Field.Group
            ></Card.Content
          >{#if runtime?.restartRequired}<Card.Footer
              ><Alert.Root class="w-full"
                ><Alert.Title>Restart required</Alert.Title><Alert.Description
                  >Saved configuration is staged. Restart the relay to activate it.</Alert.Description
                ></Alert.Root
              ></Card.Footer
            >{/if}<Card.Footer class="flex-wrap justify-end gap-2"
            ><Button
              variant="outline"
              disabled={busy || !runtime?.writable}
              onclick={validateRuntime}>Validate</Button
            ><Button
              disabled={busy || !runtime?.writable || !runtimeValidated}
              onclick={saveRuntime}>Save runtime settings</Button
            ><Button
              variant="secondary"
              disabled={busy || !runtime?.restartSupported || !runtime?.restartRequired}
              onclick={restartRuntime}>Restart relay</Button
            ></Card.Footer
          ></Card.Root
        >{/if}</Tabs.Content
    >
  </Tabs.Root>
</div>

<AlertDialog.Root
  open={Boolean(pendingProvider)}
  onOpenChange={(open) => !open && (pendingProvider = null)}
  ><AlertDialog.Content
    ><AlertDialog.Header
      ><AlertDialog.Title>Remove Jellyfin connection?</AlertDialog.Title><AlertDialog.Description
        >Existing sessions may stop resolving media from this provider.</AlertDialog.Description
      ></AlertDialog.Header
    ><AlertDialog.Footer
      ><AlertDialog.Cancel>Cancel</AlertDialog.Cancel><AlertDialog.Action
        variant="destructive"
        disabled={busy}
        onclick={removeProvider}>Remove connection</AlertDialog.Action
      ></AlertDialog.Footer
    ></AlertDialog.Content
  ></AlertDialog.Root
>
