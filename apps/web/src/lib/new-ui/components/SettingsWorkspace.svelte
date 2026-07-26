<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Copy, RefreshCw, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type {
    PersonalAccessToken,
    ProfileRevision,
    PublicProviderConnection,
    Scope
  } from '@vrrelay/domain';
  import type { SignInConfigurationRequest, RuntimeConfiguration } from '@vrrelay/contracts';
  import { api, isAuthenticatedError } from '#lib/api';
  import { adminRoute, loginRoute } from '#lib/new-ui/state.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import ConfirmAction from '#lib/new-ui/components/ConfirmAction.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Alert from '#lib/new-ui/components/ui/alert';
  import * as AlertDialog from '#lib/new-ui/components/ui/alert-dialog';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as Select from '#lib/new-ui/components/ui/select';
  import { Switch } from '#lib/new-ui/components/ui/switch';

  type Section = 'connections' | 'tokens' | 'network' | 'runtime';
  let { initialSection = 'connections' }: { initialSection?: Section } = $props();
  let providers = $state<PublicProviderConnection[]>([]);
  let profiles = $state<ProfileRevision[]>([]);
  let tokens = $state<Array<Omit<PersonalAccessToken, 'tokenHash'>>>([]);
  let runtime = $state<Awaited<ReturnType<typeof api.runtimeConfiguration>> | null>(null);
  let runtimeDraft = $state<RuntimeConfiguration | null>(null);
  let trustedProxyCidrs = $state('');
  let accessMode = $state<'local' | 'nginx-proxy-manager' | 'advanced'>('local');
  let publicHostname = $state('');
  let name = $state('Jellyfin');
  let baseUrl = $state('http://127.0.0.1:8096/jellyfin');
  let providerAuthMode = $state<'delegated' | 'user_token' | 'api_key'>('delegated');
  let providerUsername = $state('');
  let providerPassword = $state('');
  let providerApiKey = $state('');
  let allowPublicHttp = $state(false);
  let signInProviderId = $state('');
  let signInConfigured = $state(false);
  let defaultProfileId = $state('');
  let allowedProfileIds = $state<string[]>([]);
  let reportPlaybackActivity = $state(true);
  let tokenName = $state('Unity client');
  let tokenExpiresAt = $state(
    new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 16)
  );
  let newToken = $state('');
  let scopeState = $state<Record<Exclude<Scope, 'admin'>, boolean>>({
    'catalog:read': true,
    'sessions:create': true,
    'sessions:read': true,
    'sessions:control': true
  });
  let pendingProvider = $state<PublicProviderConnection | null>(null);
  let pendingToken = $state<Omit<PersonalAccessToken, 'tokenHash'> | null>(null);
  let busy = $state(false);
  let validatingProviderId = $state('');
  let runtimeValidated = $state(false);
  let loading = $state(true);
  let loadError = $state('');

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

  function preferredVodProfileId(): string {
    return (
      profileChoices.find((profile) => profile.profileId === 'universal-h264-hls-vod')?.profileId ??
      profileChoices.find(
        (profile) =>
          profile.delivery.method === 'hls' &&
          profile.delivery.container === 'mpegts' &&
          profile.delivery.segmentType === 'mpegts' &&
          profile.delivery.playlistType === 'vod'
      )?.profileId ??
      ''
    );
  }

  onMount(async () => {
    let results: PromiseSettledResult<unknown>[] = [];
    if (initialSection === 'connections') {
      const connectionResults = await Promise.allSettled([
        api.providers(),
        api.profiles(),
        api.signInConfiguration()
      ] as const);
      results = connectionResults;
      const [providerResult, profileResult, signInResult] = connectionResults;
      if (providerResult.status === 'fulfilled') providers = providerResult.value.items;
      if (profileResult.status === 'fulfilled') profiles = profileResult.value.items;
      if (signInResult.status === 'fulfilled') {
        if (signInResult.value.configuration) {
          signInProviderId = signInResult.value.configuration.providerId;
          defaultProfileId = signInResult.value.configuration.defaultProfileId;
          allowedProfileIds = signInResult.value.configuration.allowedProfileIds;
          reportPlaybackActivity = signInResult.value.configuration.reportPlaybackActivity;
        } else {
          signInProviderId =
            providers.find((provider) => provider.authMode === 'delegated')?.id ?? '';
          defaultProfileId = preferredVodProfileId();
          allowedProfileIds = defaultProfileId ? [defaultProfileId] : [];
        }
        signInConfigured = Boolean(signInResult.value.configuration);
      }
    } else if (initialSection === 'tokens') {
      const tokenResult = await Promise.allSettled([api.tokens()] as const);
      results = tokenResult;
      if (tokenResult[0].status === 'fulfilled') tokens = tokenResult[0].value.items;
    } else {
      const runtimeResult = await Promise.allSettled([api.runtimeConfiguration()] as const);
      results = runtimeResult;
      if (runtimeResult[0].status === 'fulfilled') {
        runtime = runtimeResult[0].value;
        runtimeDraft = structuredClone(runtimeResult[0].value.configuration);
        trustedProxyCidrs = runtimeResult[0].value.configuration.trustedProxyCidrs.join(', ');
        const configuredOrigin = new URL(runtimeResult[0].value.configuration.publicUrl);
        publicHostname = configuredOrigin.hostname;
        if (
          !['localhost', '::1'].includes(configuredOrigin.hostname) &&
          !configuredOrigin.hostname.startsWith('127.')
        )
          accessMode = 'advanced';
      }
    }
    const authenticationFailure = results.find(
      (result) => result.status === 'rejected' && isAuthenticatedError(result.reason)
    );
    if (authenticationFailure?.status === 'rejected') {
      loading = false;
      return goto(loginRoute(page.url.pathname));
    }
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected')
      loadError =
        failure.reason instanceof Error ? failure.reason.message : 'Could not load settings.';
    loading = false;
  });

  async function connect() {
    busy = true;
    try {
      const provider = await api.createProvider({
        type: 'jellyfin',
        name,
        baseUrl,
        authMode: providerAuthMode,
        ...(providerAuthMode === 'user_token'
          ? { username: providerUsername, password: providerPassword }
          : {}),
        ...(providerAuthMode === 'api_key' ? { apiKey: providerApiKey } : {}),
        allowPublicHttp
      });
      providerPassword = '';
      providerApiKey = '';
      providers = [provider, ...providers];
      if (!signInConfigured && provider.authMode === 'delegated') {
        signInProviderId = provider.id;
        try {
          if (await enableSignIn(provider.id)) {
            toast.success('Jellyfin endpoint added and interactive sign-in enabled.');
          } else {
            toast.warning('Endpoint added. Create a profile before enabling interactive sign-in.');
          }
        } catch (reason) {
          toast.warning(
            reason instanceof Error
              ? `Endpoint added, but interactive sign-in could not be enabled: ${reason.message}`
              : 'Endpoint added, but interactive sign-in could not be enabled.'
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

  async function enableSignIn(providerId: string): Promise<boolean> {
    const preferredProfileId = defaultProfileId || preferredVodProfileId();
    if (!preferredProfileId) return false;
    defaultProfileId = preferredProfileId;
    allowedProfileIds = allowedProfileIds.includes(preferredProfileId)
      ? allowedProfileIds
      : [...new Set([preferredProfileId, ...allowedProfileIds])];
    await api.updateSignInConfiguration({
      providerId,
      defaultProfileId,
      allowedProfileIds,
      reportPlaybackActivity
    });
    signInConfigured = true;
    return true;
  }

  async function saveSignInConfiguration() {
    if (!signInProviderId || !defaultProfileId || allowedProfileIds.length === 0) return;
    busy = true;
    try {
      const configuration: SignInConfigurationRequest = {
        providerId: signInProviderId,
        defaultProfileId,
        allowedProfileIds,
        reportPlaybackActivity
      };
      await api.updateSignInConfiguration(configuration);
      signInConfigured = true;
      toast.success('Interactive sign-in configuration saved.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not save interactive sign-in.');
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
      const result = await api.createToken({
        name: tokenName,
        scopes,
        expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null
      });
      newToken = result.token;
      const { token: _token, ...record } = result;
      tokens = [record, ...tokens];
      toast.success('Personal token created.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not create token.');
    }
  }

  async function revokeToken(id: string) {
    await api.revokeToken(id);
    tokens = tokens.map((token) =>
      token.id === id ? { ...token, revokedAt: new Date().toISOString() } : token
    );
    toast.success('Token revoked.');
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

  function applyPublicHostname() {
    if (!runtimeDraft) return;
    const supplied = publicHostname.trim().replace(/\/$/, '');
    if (!supplied) {
      toast.error('Enter the public hostname first.');
      return;
    }
    try {
      const candidate = new URL(supplied.includes('://') ? supplied : `https://${supplied}`);
      if (
        candidate.protocol !== 'https:' ||
        candidate.username ||
        candidate.password ||
        candidate.pathname !== '/' ||
        candidate.search ||
        candidate.hash
      ) {
        throw new Error('Use a hostname only, without a path, credentials, query, or fragment.');
      }
      const origin = candidate.origin;
      runtimeDraft.publicUrl = origin;
      runtimeDraft.adminUrl = origin;
      runtimeDraft.playbackUrl = origin;
      publicHostname = candidate.host;
      runtimeValidated = false;
      toast.success('Public, admin, and playback URLs now use this HTTPS hostname.');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Enter a valid HTTPS hostname.');
    }
  }

  async function copyNpmNetworkCommand() {
    try {
      await navigator.clipboard.writeText(
        "docker network inspect <npm-network-name> --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'"
      );
      toast.success('Docker network command copied.');
    } catch {
      toast.error('Could not copy the Docker network command.');
    }
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
      const result = await api.updateRuntimeConfiguration(request);
      runtimeDraft = structuredClone(result.configuration);
      trustedProxyCidrs = result.configuration.trustedProxyCidrs.join(', ');
      runtime = result;
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
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title={initialSection === 'connections'
      ? 'Connections'
      : initialSection === 'tokens'
        ? 'API access'
        : initialSection === 'network'
          ? 'Network'
          : 'Runtime'}
    description={initialSection === 'connections'
      ? 'Jellyfin sign-in, relay providers, validation and placement.'
      : initialSection === 'tokens'
        ? 'Personal tokens, scoped permissions, expiry and revocation.'
        : initialSection === 'network'
          ? 'Listen addresses, public URLs and trusted reverse proxies.'
          : 'Node identity, worker capacity, cache policy and service actions.'}
  />
  <LoadState {loading} error={loadError} label="settings" variant="form" />

  {#if !loading && !loadError && initialSection === 'connections'}
    <div class="grid gap-4 xl:grid-cols-2">
      <Card.Root>
        <Card.Header>
          <Card.Title>Jellyfin endpoint</Card.Title>
          <Card.Description>
            Users sign in with their own Jellyfin credentials. VRRelay never stores their passwords.
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
          <Card.Description>
            Use per-user sign-in for the dashboard catalog, or store an administrator-managed
            credential for placement-aware relay workflows.
          </Card.Description>
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
            <Field.Field>
              <Field.Label>Credential mode</Field.Label>
              <Select.Root type="single" bind:value={providerAuthMode}>
                <Select.Trigger class="w-full">
                  {providerAuthMode === 'delegated'
                    ? 'Per-user sign-in'
                    : providerAuthMode === 'user_token'
                      ? 'Stored user token'
                      : 'Stored API key'}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="delegated">Per-user sign-in</Select.Item>
                  <Select.Item value="user_token">Stored user token</Select.Item>
                  <Select.Item value="api_key">Stored API key</Select.Item>
                </Select.Content>
              </Select.Root>
              <Field.Description>
                Stored credentials are written to the configured secret backend and are never
                returned by the API.
              </Field.Description>
            </Field.Field>
            {#if providerAuthMode === 'user_token'}
              <Field.Field>
                <Field.Label for="connection-username">Jellyfin username</Field.Label>
                <Input
                  id="connection-username"
                  autocomplete="username"
                  bind:value={providerUsername}
                />
              </Field.Field>
              <Field.Field>
                <Field.Label for="connection-password">Jellyfin password</Field.Label>
                <Input
                  id="connection-password"
                  type="password"
                  autocomplete="new-password"
                  bind:value={providerPassword}
                />
              </Field.Field>
            {:else if providerAuthMode === 'api_key'}
              <Field.Field>
                <Field.Label for="connection-api-key">Jellyfin API key</Field.Label>
                <Input
                  id="connection-api-key"
                  type="password"
                  autocomplete="off"
                  bind:value={providerApiKey}
                />
              </Field.Field>
            {/if}
            <label
              class="flex items-center justify-between rounded-lg border p-3"
              for="public-http"
            >
              <span class="text-sm">Allow public HTTP</span>
              <Switch id="public-http" bind:checked={allowPublicHttp} />
            </label>
            <Button
              disabled={busy ||
                !name ||
                !baseUrl ||
                (providerAuthMode === 'user_token' && (!providerUsername || !providerPassword)) ||
                (providerAuthMode === 'api_key' && !providerApiKey)}
              onclick={connect}>Add endpoint</Button
            >
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
              <Field.Label>Sign-in connection</Field.Label>
              <Select.Root type="single" bind:value={signInProviderId}>
                <Select.Trigger class="w-full">
                  {providers.find((provider) => provider.id === signInProviderId)?.name ??
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
                  {profileChoices.find((profile) => profile.profileId === defaultProfileId)?.name ??
                    'Select profile'}
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
                    for={`sign-in-profile-${profile.profileId}`}
                  >
                    <span class="text-sm">{profile.name}</span>
                    <Switch
                      id={`sign-in-profile-${profile.profileId}`}
                      checked={allowedProfileIds.includes(profile.profileId)}
                      onCheckedChange={(checked) => setProfileAllowed(profile.profileId, checked)}
                    />
                  </label>
                {/each}
              </div>
            </Field.Field>
            <label
              class="flex items-center justify-between gap-4 rounded-lg border p-3"
              for="report-playback-activity"
            >
              <span>
                <span class="block text-sm font-medium">Save playback activity to Jellyfin</span>
                <span class="text-muted-foreground block text-xs">
                  When disabled, VRRelay still tracks viewers and session health, but Jellyfin does
                  not receive play, progress, or stop events.
                </span>
              </span>
              <Switch id="report-playback-activity" bind:checked={reportPlaybackActivity} />
            </label>
            <Button
              disabled={busy ||
                !signInProviderId ||
                !defaultProfileId ||
                allowedProfileIds.length === 0}
              onclick={saveSignInConfiguration}>Save user access</Button
            >
          </Field.Group>
        </Card.Content>
      </Card.Root>
    </div>
  {/if}

  {#if !loading && !loadError && initialSection === 'tokens'}
    <div class="grid gap-4 xl:grid-cols-2">
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
            ><Field.Field
              ><Field.Label for="token-expiry">Expiry</Field.Label><Input
                id="token-expiry"
                type="datetime-local"
                bind:value={tokenExpiresAt}
              /><Field.Description
                >Leave blank only for a deliberately non-expiring integration token.</Field.Description
              ></Field.Field
            >{#each Object.keys(scopeState) as scope}<label
                class="flex items-center justify-between rounded-lg border p-3"
                for={`scope-${scope}`}
                ><span class="text-sm">{scope}</span><Switch
                  id={`scope-${scope}`}
                  checked={scopeState[scope as keyof typeof scopeState]}
                  onCheckedChange={(checked) => (scopeState = { ...scopeState, [scope]: checked })}
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
                  onclick={async () => {
                    try {
                      await navigator.clipboard.writeText(newToken);
                      toast.success('Token copied.');
                    } catch {
                      toast.error(
                        'Clipboard access was denied. Select and copy the token manually.'
                      );
                    }
                  }}><Copy data-icon="inline-start" />Copy</Button
                ></Alert.Action
              ></Alert.Root
            >{/if}{#each tokens as token}<div
              class="flex items-center gap-3 rounded-lg border p-3"
              data-testid={`personal-token-${token.id}`}
            >
              <div class="min-w-0 flex-1">
                <strong class="block">{token.name}</strong><span
                  class="text-muted-foreground text-xs">{token.scopes.join(', ')}</span
                >
                <span class="text-muted-foreground block text-xs">
                  {token.expiresAt
                    ? `Expires ${new Date(token.expiresAt).toLocaleString()}`
                    : 'Does not expire'}
                </span>
              </div>
              <StatusBadge
                value={token.revokedAt ? 'revoked' : 'active'}
              />{#if !token.revokedAt}<Button
                  variant="destructive"
                  size="sm"
                  onclick={() => (pendingToken = token)}>Revoke</Button
                >{/if}
            </div>{/each}</Card.Content
        ></Card.Root
      >
    </div>
  {/if}

  {#if !loading && !loadError && initialSection === 'network'}
    {#if runtimeDraft && runtime && !runtime.writable}
      <Card.Root>
        <Card.Header>
          <Card.Title>Network configuration is managed externally</Card.Title>
          <Card.Description
            >Change these values in the service environment or deployment manifest, then restart
            VRRelay.</Card.Description
          >
        </Card.Header>
        <Card.Content class="grid gap-3 text-sm md:grid-cols-2">
          <div>
            <span class="text-muted-foreground block">Listen address</span><code
              >{runtimeDraft.listenAddr}</code
            >
          </div>
          <div>
            <span class="text-muted-foreground block">Agent address</span><code
              >{runtimeDraft.agentListenAddr}</code
            >
          </div>
          <div>
            <span class="text-muted-foreground block">Administration URL</span><code
              class="break-all">{runtimeDraft.adminUrl}</code
            >
          </div>
          <div>
            <span class="text-muted-foreground block">Playback URL</span><code class="break-all"
              >{runtimeDraft.playbackUrl}</code
            >
          </div>
          <div class="md:col-span-2">
            <span class="text-muted-foreground block">Trusted proxies</span><code
              >{runtimeDraft.trustedProxyCidrs.join(', ') || 'None'}</code
            >
          </div>
        </Card.Content>
      </Card.Root>
    {:else if runtimeDraft}
      <Card.Root>
        <Card.Header>
          <Card.Title>Network endpoints</Card.Title>
          <Card.Description>
            Configure how administrators and VRChat players reach this relay.
          </Card.Description>
        </Card.Header>
        <Card.Content class="space-y-5">
          <Alert.Root>
            <Alert.Title>Publish safely</Alert.Title>
            <Alert.Description>
              VRRelay can save its own advertised URLs and proxy-trust policy, but your DNS, router,
              TLS certificate, and reverse proxy remain under your control.
            </Alert.Description>
          </Alert.Root>
          <Field.Group class="grid md:grid-cols-2">
            <Field.Field class="md:col-span-2">
              <Field.Label>Access pattern</Field.Label>
              <Select.Root
                type="single"
                value={accessMode}
                disabled={!runtime?.writable}
                onValueChange={(value) => value && (accessMode = value as typeof accessMode)}
              >
                <Select.Trigger class="w-full">
                  {accessMode === 'local'
                    ? 'Local network only'
                    : accessMode === 'nginx-proxy-manager'
                      ? 'Nginx Proxy Manager'
                      : 'Another reverse proxy or advanced setup'}
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    <Select.Item value="local">Local network only</Select.Item>
                    <Select.Item value="nginx-proxy-manager">Nginx Proxy Manager</Select.Item>
                    <Select.Item value="advanced">
                      Another reverse proxy or advanced setup
                    </Select.Item>
                  </Select.Group>
                </Select.Content>
              </Select.Root>
            </Field.Field>
            {#if accessMode === 'nginx-proxy-manager'}
              <Field.Field class="md:col-span-2">
                <Field.Label for="public-hostname">Public HTTPS hostname</Field.Label>
                <div class="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="public-hostname"
                    placeholder="relay.example.com"
                    bind:value={publicHostname}
                    disabled={!runtime?.writable}
                    oninput={() => (runtimeValidated = false)}
                  />
                  <Button
                    variant="outline"
                    disabled={!runtime?.writable}
                    onclick={applyPublicHostname}>Use for all URLs</Button
                  >
                </div>
                <Field.Description>
                  This sets the public, administration, and playback URLs to one HTTPS origin. Split
                  them only when you deliberately use separate domains.
                </Field.Description>
              </Field.Field>
            {/if}
            <Field.Field>
              <Field.Label for="listen-address">Listen address</Field.Label>
              <Input
                id="listen-address"
                bind:value={runtimeDraft.listenAddr}
                disabled={!runtime?.writable}
                oninput={() => (runtimeValidated = false)}
              />
              <Field.Description>
                Use localhost, a specific interface IP, or 0.0.0.0 for every IPv4 interface. IPv6
                addresses may use brackets, for example [::]:8099.
              </Field.Description>
            </Field.Field>
            <Field.Field>
              <Field.Label for="agent-address">Agent listen address</Field.Label>
              <Input
                id="agent-address"
                bind:value={runtimeDraft.agentListenAddr}
                disabled={!runtime?.writable}
                oninput={() => (runtimeValidated = false)}
              />
            </Field.Field>
            <Field.Field>
              <Field.Label for="public-url">Public URL</Field.Label>
              <Input
                id="public-url"
                type="url"
                bind:value={runtimeDraft.publicUrl}
                disabled={!runtime?.writable}
                oninput={() => (runtimeValidated = false)}
              />
            </Field.Field>
            <Field.Field>
              <Field.Label for="admin-url">Admin URL</Field.Label>
              <Input
                id="admin-url"
                type="url"
                bind:value={runtimeDraft.adminUrl}
                disabled={!runtime?.writable}
                oninput={() => (runtimeValidated = false)}
              />
            </Field.Field>
            <Field.Field>
              <Field.Label for="playback-url">Playback URL</Field.Label>
              <Input
                id="playback-url"
                type="url"
                bind:value={runtimeDraft.playbackUrl}
                disabled={!runtime?.writable}
                oninput={() => (runtimeValidated = false)}
              />
            </Field.Field>
            <Field.Field>
              <Field.Label for="trusted-proxies">Trusted proxy CIDRs</Field.Label>
              <Input
                id="trusted-proxies"
                bind:value={trustedProxyCidrs}
                placeholder="172.18.0.0/16"
                disabled={!runtime?.writable}
                oninput={() => (runtimeValidated = false)}
              />
              {#if accessMode === 'nginx-proxy-manager'}
                <Field.Description>
                  Enter the Docker network subnet or exact address NPM uses to connect to
                  VRRelay—not your home LAN or the public internet.
                </Field.Description>
              {/if}
            </Field.Field>
            <Field.Field>
              <Field.Label for="viewer-region-header">Viewer region header</Field.Label>
              <Input
                id="viewer-region-header"
                bind:value={runtimeDraft.viewerRegionHeader}
                placeholder="x-vrrelay-region"
                disabled={!runtime?.writable}
                oninput={() => (runtimeValidated = false)}
              />
              <Field.Description>
                Accepted only from the trusted proxy CIDRs above. The value must match a configured
                node region.
              </Field.Description>
            </Field.Field>
          </Field.Group>
          {#if accessMode === 'nginx-proxy-manager'}
            <div class="rounded-lg border p-4 text-sm">
              <h3 class="font-medium">Nginx Proxy Manager checklist</h3>
              <ol class="text-muted-foreground mt-3 list-decimal space-y-2 pl-5">
                <li>
                  Create a Proxy Host for <code>{publicHostname || 'relay.example.com'}</code>
                  that forwards HTTP to the relay host on port <code>8099</code>.
                </li>
                <li>
                  Request a trusted TLS certificate, force HTTPS, and enable WebSocket support.
                </li>
                <li>
                  Point public DNS at the NPM host and forward TCP ports <code>80</code> and
                  <code>443</code> to it.
                </li>
                <li>
                  Do not expose port <code>8099</code> directly or publish
                  <code>/internal/*</code>, <code>/metrics*</code>, or <code>/debug*</code>.
                </li>
                <li>
                  Discover NPM's Docker subnet, enter it above, then validate, save, and restart
                  VRRelay.
                </li>
              </ol>
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <code class="rounded bg-muted px-2 py-1 text-xs">
                  docker network inspect &lt;npm-network-name&gt; …
                </code>
                <Button variant="outline" size="sm" onclick={copyNpmNetworkCommand}>
                  Copy command
                </Button>
              </div>
            </div>
          {/if}
        </Card.Content>
        <Card.Footer class="justify-end gap-2">
          <Button variant="outline" disabled={busy || !runtime?.writable} onclick={validateRuntime}
            >Validate</Button
          >
          <Button disabled={busy || !runtime?.writable || !runtimeValidated} onclick={saveRuntime}
            >Save network settings</Button
          >
        </Card.Footer>
      </Card.Root>
    {/if}
  {/if}

  {#if !loading && !loadError && initialSection === 'runtime'}
    {#if runtimeDraft}<Card.Root
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
              ><Field.Label for="producer-max-concurrent">Maximum VOD producers</Field.Label><Input
                id="producer-max-concurrent"
                type="number"
                min="1"
                max="32"
                bind:value={runtimeDraft.vodProducerMaxConcurrent}
                disabled={!runtime?.writable}
                oninput={() => (runtimeValidated = false)}
              /><Field.Description
                >Limits continuous source producers on this node. Other transcode work still uses
                the general worker pool.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="producer-max-provider">Maximum producers per provider</Field.Label
              ><Input
                id="producer-max-provider"
                type="number"
                min="1"
                max="32"
                bind:value={runtimeDraft.vodProducerMaxPerProvider}
                disabled={!runtime?.writable}
                oninput={() => (runtimeValidated = false)}
              /><Field.Description
                >Caps simultaneous VOD source connections to one provider on this node.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label>Diagnostic logging</Field.Label><Select.Root
                type="single"
                value={runtimeDraft.logLevel}
                disabled={!runtime?.writable}
                onValueChange={(value) => {
                  if (!value) return;
                  runtimeDraft!.logLevel = value as RuntimeConfiguration['logLevel'];
                  runtimeValidated = false;
                }}
                ><Select.Trigger class="w-full"
                  >{runtimeDraft.logLevel === 'debug'
                    ? 'Detailed playback tracing'
                    : 'Normal operational logging'}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    ><Select.Item value="info">Normal operational logging</Select.Item><Select.Item
                      value="debug">Detailed playback tracing</Select.Item
                    ></Select.Group
                  ></Select.Content
                ></Select.Root
              ><Field.Description
                >Detailed mode records every redacted playback request. Normal mode still records
                client starts, seeks, routing decisions, and configuration changes.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="cache-limit">Cache limit (GiB)</Field.Label><Input
                id="cache-limit"
                type="number"
                min="0.1"
                step="0.1"
                value={(runtimeDraft.cacheLimitBytes / 1_073_741_824).toFixed(1)}
                disabled={!runtime?.writable}
                oninput={(event) => {
                  runtimeDraft!.cacheLimitBytes = Math.round(
                    Number(event.currentTarget.value) * 1_073_741_824
                  );
                  runtimeValidated = false;
                }}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="cache-ttl">Cache idle time (minutes)</Field.Label><Input
                id="cache-ttl"
                type="number"
                min="1"
                value={Math.round(runtimeDraft.cacheTtlMs / 60_000)}
                disabled={!runtime?.writable}
                oninput={(event) => {
                  runtimeDraft!.cacheTtlMs = Math.round(Number(event.currentTarget.value) * 60_000);
                  runtimeValidated = false;
                }}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="producer-idle-timeout"
                >VOD producer idle time (seconds)</Field.Label
              ><Input
                id="producer-idle-timeout"
                type="number"
                min="15"
                max="600"
                value={Math.round(runtimeDraft.vodProducerIdleTimeoutMs / 1_000)}
                disabled={!runtime?.writable}
                oninput={(event) => {
                  runtimeDraft!.vodProducerIdleTimeoutMs = Math.round(
                    Number(event.currentTarget.value) * 1_000
                  );
                  runtimeValidated = false;
                }}
              /><Field.Description
                >Stops the continuous source connection after demand goes quiet. HLS VOD viewers
                share one fenced producer generation for each session.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="producer-catchup-rate">VOD catch-up aggressiveness</Field.Label
              ><Input
                id="producer-catchup-rate"
                type="range"
                min="1"
                max="2"
                step="0.1"
                value={runtimeDraft.vodProducerCatchupRate}
                disabled={!runtime?.writable}
                oninput={(event) => {
                  runtimeDraft!.vodProducerCatchupRate = Number(event.currentTarget.value);
                  runtimeValidated = false;
                }}
              /><Field.Description
                >{runtimeDraft.vodProducerCatchupRate.toFixed(1)}× source catch-up rate. Higher
                values fill the 30–60 second buffer faster.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label>Default H.264 encoder</Field.Label><Select.Root
                type="single"
                value={runtimeDraft.vodProducerEncoder}
                disabled={!runtime?.writable}
                onValueChange={(value) => {
                  if (!value) return;
                  runtimeDraft!.vodProducerEncoder =
                    value as RuntimeConfiguration['vodProducerEncoder'];
                  runtimeValidated = false;
                }}
                ><Select.Trigger class="w-full">{runtimeDraft.vodProducerEncoder}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    ><Select.Item value="auto">Auto (best available)</Select.Item><Select.Item
                      value="libx264">libx264 (software)</Select.Item
                    ><Select.Item value="h264_videotoolbox">VideoToolbox</Select.Item><Select.Item
                      value="h264_nvenc">NVIDIA NVENC</Select.Item
                    ><Select.Item value="h264_qsv">Intel Quick Sync</Select.Item><Select.Item
                      value="h264_vaapi">VA-API</Select.Item
                    ><Select.Item value="h264_amf">AMD AMF</Select.Item></Select.Group
                  ></Select.Content
                ></Select.Root
              ><Field.Description
                >Forces newly created built-in H.264 profiles after restart. The selected encoder
                must be available on each source worker.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="producer-buffer-low"
                >VOD buffer refill threshold (seconds)</Field.Label
              ><Input
                id="producer-buffer-low"
                type="number"
                min="4"
                max="300"
                value={Math.round(runtimeDraft.vodProducerBufferLowWatermarkMs / 1_000)}
                disabled={!runtime?.writable}
                oninput={(event) => {
                  runtimeDraft!.vodProducerBufferLowWatermarkMs = Math.round(
                    Number(event.currentTarget.value) * 1_000
                  );
                  runtimeValidated = false;
                }}
              /><Field.Description
                >When producer headroom reaches this level, catch-up transcoding resumes.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="producer-buffer-high">VOD buffer target (seconds)</Field.Label
              ><Input
                id="producer-buffer-high"
                type="number"
                min="8"
                max="600"
                value={Math.round(runtimeDraft.vodProducerBufferHighWatermarkMs / 1_000)}
                disabled={!runtime?.writable}
                oninput={(event) => {
                  runtimeDraft!.vodProducerBufferHighWatermarkMs = Math.round(
                    Number(event.currentTarget.value) * 1_000
                  );
                  runtimeValidated = false;
                }}
              /><Field.Description
                >Catch-up pauses at this level. It must be greater than the refill threshold.</Field.Description
              ></Field.Field
            ></Field.Group
          ></Card.Content
        >{#if runtime?.restartRequired}<Card.Footer
            ><Alert.Root class="w-full"
              ><Alert.Title>Restart required</Alert.Title><Alert.Description
                >Saved configuration is staged. Restart the relay to activate it.</Alert.Description
              ></Alert.Root
            ></Card.Footer
          >{/if}<Card.Footer class="flex-wrap justify-end gap-2"
          ><Button variant="outline" disabled={busy || !runtime?.writable} onclick={validateRuntime}
            >Validate</Button
          ><Button disabled={busy || !runtime?.writable || !runtimeValidated} onclick={saveRuntime}
            >Save runtime settings</Button
          ></Card.Footer
        ></Card.Root
      >
      <Card.Root class="border-destructive/40">
        <Card.Header
          ><Card.Title>Service actions</Card.Title><Card.Description
            >Restarting interrupts active work. Use it only after saving changes that require
            activation.</Card.Description
          ></Card.Header
        >
        <Card.Footer
          ><Button
            variant="destructive"
            disabled={busy || !runtime?.restartSupported || !runtime?.restartRequired}
            onclick={restartRuntime}>Restart relay</Button
          ></Card.Footer
        >
      </Card.Root>
    {/if}
  {/if}
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

<ConfirmAction
  open={Boolean(pendingToken)}
  onOpenChange={(open) => !open && (pendingToken = null)}
  title="Revoke personal access token?"
  description={`Revoke ${pendingToken?.name ?? 'this token'} immediately. Clients using it will need a replacement token.`}
  confirmLabel="Revoke token"
  onConfirm={async () => {
    if (!pendingToken) return;
    await revokeToken(pendingToken.id);
    pendingToken = null;
  }}
/>
