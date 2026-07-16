<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    Copy,
    KeyRound,
    LoaderCircle,
    LogOut,
    Network,
    RefreshCw,
    Save,
    Server,
    Trash2,
    Wrench
  } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { PersonalAccessToken, PublicProviderConnection, Scope } from '@vrrelay/domain';
  import type { RuntimeConfiguration } from '@vrrelay/contracts';
  import AppShell from '$lib/components/AppShell.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';
  import * as Field from '$lib/components/ui/field';
  import * as Select from '$lib/components/ui/select';
  import * as Alert from '$lib/components/ui/alert';
  import * as Dialog from '$lib/components/ui/dialog';
  let providers = $state<PublicProviderConnection[]>([]),
    saving = $state(false),
    deletingProvider = $state(false),
    pendingProvider = $state<PublicProviderConnection | null>(null),
    baseUrl = $state('http://127.0.0.1:8096/jellyfin'),
    name = $state('Jellyfin'),
    username = $state(''),
    password = $state(''),
    authMode = $state<'user_token' | 'api_key'>('user_token'),
    apiKey = $state(''),
    allowPublicHttp = $state(false),
    tokenName = $state('Unity client'),
    newToken = $state(''),
    tokens = $state<Array<Omit<PersonalAccessToken, 'tokenHash'>>>([]),
    catalogRead = $state(true),
    sessionsCreate = $state(true),
    sessionsRead = $state(true),
    sessionsControl = $state(true),
    runtime = $state<{
      configuration: RuntimeConfiguration;
      writable: boolean;
      restartSupported: boolean;
      restartRequired: boolean;
      environment: 'development' | 'production';
      version: string;
    } | null>(null),
    runtimeDraft = $state<RuntimeConfiguration | null>(null),
    trustedProxyCidrs = $state(''),
    validatingRuntime = $state(false),
    savingRuntime = $state(false),
    restartingRuntime = $state(false),
    runtimeValidated = $state(false),
    validatingProviderId = $state('');
  const scopes = $derived(
    [
      catalogRead && 'catalog:read',
      sessionsCreate && 'sessions:create',
      sessionsRead && 'sessions:read',
      sessionsControl && 'sessions:control'
    ].filter((scope): scope is Scope => Boolean(scope))
  );
  onMount(async () => {
    try {
      const [providerResult, tokenResult, runtimeResult] = await Promise.all([
        api.providers(),
        api.tokens(),
        api.runtimeConfiguration()
      ]);
      providers = providerResult.items;
      tokens = tokenResult.items;
      runtime = runtimeResult;
      runtimeDraft = structuredClone(runtimeResult.configuration);
      trustedProxyCidrs = runtimeResult.configuration.trustedProxyCidrs.join(', ');
    } catch (e) {
      if (isAuthenticatedError(e)) return goto('/login');
    }
  });
  async function connect() {
    saving = true;
    try {
      const p = await api.createProvider({
        type: 'jellyfin',
        name,
        baseUrl,
        authMode,
        username: authMode === 'user_token' ? username : undefined,
        password: authMode === 'user_token' ? password : undefined,
        apiKey: authMode === 'api_key' ? apiKey : undefined,
        allowPublicHttp
      });
      providers = [p, ...providers];
      password = '';
      apiKey = '';
      toast.success('Jellyfin connected.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Connection failed.');
    } finally {
      saving = false;
    }
  }
  async function createToken() {
    try {
      const result = await api.createToken({ name: tokenName, scopes, expiresAt: null });
      newToken = result.token;
      const { token: _token, ...record } = result;
      tokens = [record, ...tokens];
      toast.success('Personal token created.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create token.');
    }
  }
  async function revokeToken(tokenId: string) {
    try {
      await api.revokeToken(tokenId);
      const revokedAt = new Date().toISOString();
      tokens = tokens.map((token) => (token.id === tokenId ? { ...token, revokedAt } : token));
      toast.success('Personal token revoked.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not revoke the token.');
    }
  }
  async function removeProvider() {
    if (!pendingProvider || deletingProvider) return;
    const provider = pendingProvider;
    deletingProvider = true;
    try {
      await api.deleteProvider(provider.id);
      providers = providers.filter((candidate) => candidate.id !== provider.id);
      pendingProvider = null;
      toast.success('Jellyfin connection removed.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove the connection.');
    } finally {
      deletingProvider = false;
    }
  }
  async function revalidateProvider(providerId: string) {
    validatingProviderId = providerId;
    try {
      await api.validateProvider(providerId);
      providers = (await api.providers()).items;
      toast.success('Jellyfin connection is healthy.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Provider validation failed.');
    } finally {
      validatingProviderId = '';
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
    validatingRuntime = true;
    runtimeValidated = false;
    try {
      const result = await api.validateRuntimeConfiguration(request);
      runtimeDraft = result.configuration;
      trustedProxyCidrs = result.configuration.trustedProxyCidrs.join(', ');
      runtimeValidated = true;
      toast.success('Configuration is valid.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Configuration validation failed.');
    } finally {
      validatingRuntime = false;
    }
  }
  async function saveRuntime() {
    const request = runtimeRequest();
    if (!request || !runtime?.writable) return;
    savingRuntime = true;
    try {
      runtime = await api.updateRuntimeConfiguration(request);
      runtimeDraft = structuredClone(runtime.configuration);
      trustedProxyCidrs = runtime.configuration.trustedProxyCidrs.join(', ');
      runtimeValidated = true;
      toast.success('Configuration saved. Restart the service to activate it.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save configuration.');
    } finally {
      savingRuntime = false;
    }
  }
  async function restartRuntime() {
    if (!runtime?.restartSupported) return;
    restartingRuntime = true;
    try {
      await api.restartRuntime();
      toast.success('Relay restart requested. Reconnecting…');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      window.location.href = runtimeDraft?.adminUrl ?? '/';
    } catch (error) {
      restartingRuntime = false;
      toast.error(error instanceof Error ? error.message : 'Could not restart the relay.');
    }
  }
  async function logout() {
    await api.logout();
    goto('/login');
  }
</script>

<AppShell active="settings"
  ><div class="page">
    <PageHeader
      title="Settings"
      description="Provider credentials, transport policy, and scoped client access."
      >{#snippet actions()}<Button variant="outline" onclick={() => void logout()}
          ><LogOut />Sign out</Button
        >{/snippet}</PageHeader
    >
    <div class="columns">
      <section>
        <div class="heading">
          <Server />
          <div>
            <h2>Jellyfin connection</h2>
            <p>Passwords are exchanged once and immediately discarded.</p>
          </div>
        </div>
        {#each providers as p}<div class="provider">
            <span class:healthy={p.healthy}></span>
            <div><strong>{p.name}</strong><small>{p.serverName} · {p.serverVersion}</small></div>
            <code>{p.baseUrl}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Revalidate ${p.name}`}
              disabled={validatingProviderId === p.id}
              onclick={() => void revalidateProvider(p.id)}
              >{#if validatingProviderId === p.id}<LoaderCircle
                  class="animate-spin"
                />{:else}<RefreshCw />{/if}</Button
            >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${p.name}`}
              onclick={() => (pendingProvider = p)}><Trash2 /></Button
            >
          </div>{/each}<Field.FieldGroup
          ><Field.Field
            ><Field.FieldLabel for="provider-name">Connection name</Field.FieldLabel><Input
              id="provider-name"
              bind:value={name}
            /></Field.Field
          ><Field.Field
            ><Field.FieldLabel for="provider-url">Jellyfin URL</Field.FieldLabel><Input
              id="provider-url"
              bind:value={baseUrl}
            /><Field.FieldDescription
              >Private-network HTTP is allowed with a persistent warning.</Field.FieldDescription
            ></Field.Field
          ><Field.Field
            ><Field.FieldLabel for="provider-authentication">Authentication</Field.FieldLabel
            ><Select.Root type="single" bind:value={authMode}
              ><Select.Trigger id="provider-authentication"
                >{authMode === 'user_token'
                  ? 'User credentials (recommended)'
                  : 'Server API key (advanced)'}</Select.Trigger
              ><Select.Content
                ><Select.Group
                  ><Select.Item value="user_token" label="User credentials"
                    >User credentials (recommended)</Select.Item
                  ><Select.Item value="api_key" label="Server API key"
                    >Server API key (advanced)</Select.Item
                  ></Select.Group
                ></Select.Content
              ></Select.Root
            ></Field.Field
          >{#if authMode === 'user_token'}<div class="two">
              <Field.Field
                ><Field.FieldLabel for="provider-username">Username</Field.FieldLabel><Input
                  id="provider-username"
                  bind:value={username}
                  autocomplete="username"
                /></Field.Field
              ><Field.Field
                ><Field.FieldLabel for="provider-password">Password</Field.FieldLabel><Input
                  id="provider-password"
                  type="password"
                  bind:value={password}
                  autocomplete="current-password"
                /></Field.Field
              >
            </div>{:else}<Field.Field
              ><Field.FieldLabel for="provider-api-key">API key</Field.FieldLabel><Input
                id="provider-api-key"
                type="password"
                bind:value={apiKey}
              /><Field.FieldDescription
                >Broad server access; use only for service-mode deployments.</Field.FieldDescription
              ></Field.Field
            >{/if}<label class="toggle"
            ><span
              ><strong>Allow public HTTP</strong><small
                >Unsafe. Private and loopback HTTP do not require this.</small
              ></span
            ><Switch bind:checked={allowPublicHttp} /></label
          ><Button
            disabled={saving ||
              !baseUrl ||
              !(authMode === 'api_key' ? apiKey : username && password)}
            onclick={() => void connect()}>{saving ? 'Connecting…' : 'Connect and validate'}</Button
          ></Field.FieldGroup
        >
      </section>
      <section>
        <div class="heading">
          <KeyRound />
          <div>
            <h2>Personal access tokens</h2>
            <p>For future Unity, Jellyfin plugin, and lite clients.</p>
          </div>
        </div>
        <Alert.Root
          ><Alert.Title>Scoped by default</Alert.Title><Alert.Description
            >This token can browse the catalog and manage relay sessions, but cannot administer
            VRRelay.</Alert.Description
          ></Alert.Root
        ><Field.FieldGroup
          ><Field.Field
            ><Field.FieldLabel for="personal-token-name">Token name</Field.FieldLabel><Input
              id="personal-token-name"
              bind:value={tokenName}
            /></Field.Field
          >
          <div class="scope-list">
            <label class="toggle"
              ><span><strong>Catalog read</strong></span><Switch
                bind:checked={catalogRead}
              /></label
            >
            <label class="toggle"
              ><span><strong>Create sessions</strong></span><Switch
                bind:checked={sessionsCreate}
              /></label
            >
            <label class="toggle"
              ><span><strong>Read sessions</strong></span><Switch
                bind:checked={sessionsRead}
              /></label
            >
            <label class="toggle"
              ><span><strong>Control sessions</strong></span><Switch
                bind:checked={sessionsControl}
              /></label
            >
          </div>
          <Button disabled={!tokenName || scopes.length === 0} onclick={() => void createToken()}
            >Create token</Button
          >{#if newToken}<div class="token">
              <strong>Copy this token now</strong><code>{newToken}</code><Button
                variant="outline"
                size="sm"
                onclick={() => navigator.clipboard.writeText(newToken)}><Copy />Copy token</Button
              >
            </div>{/if}</Field.FieldGroup
        >
        <div class="token-list">
          {#each tokens as token}
            <article>
              <div>
                <strong>{token.name}</strong>
                <small>{token.scopes.join(', ')}</small>
                <small
                  >{token.lastUsedAt
                    ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                    : 'Never used'}</small
                >
              </div>
              <span class:revoked={token.revokedAt}
                >{token.revokedAt ? 'Revoked' : token.expiresAt ? 'Expires' : 'Active'}</span
              >
              {#if !token.revokedAt}<Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Revoke ${token.name}`}
                  onclick={() => void revokeToken(token.id)}><Trash2 /></Button
                >{/if}
            </article>
          {:else}<p class="empty">No personal access tokens yet.</p>{/each}
        </div>
      </section>
    </div>
    {#if runtime && runtimeDraft}
      <div class="configuration-grid">
        <section>
          <div class="heading">
            <Network />
            <div>
              <h2>Network</h2>
              <p>Listener addresses and URLs advertised to administrators and players.</p>
            </div>
          </div>
          <Field.FieldGroup>
            <div class="two">
              <Field.Field>
                <Field.FieldLabel for="listen-address">Dashboard/API listener</Field.FieldLabel>
                <Input
                  id="listen-address"
                  bind:value={runtimeDraft.listenAddr}
                  disabled={!runtime.writable}
                  oninput={() => (runtimeValidated = false)}
                />
              </Field.Field>
              <Field.Field>
                <Field.FieldLabel for="agent-listener">Agent listener</Field.FieldLabel>
                <Input
                  id="agent-listener"
                  bind:value={runtimeDraft.agentListenAddr}
                  disabled={!runtime.writable}
                  oninput={() => (runtimeValidated = false)}
                />
              </Field.Field>
            </div>
            <Field.Field>
              <Field.FieldLabel for="admin-url">Administration URL</Field.FieldLabel>
              <Input
                id="admin-url"
                type="url"
                bind:value={runtimeDraft.adminUrl}
                disabled={!runtime.writable}
                oninput={() => (runtimeValidated = false)}
              />
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="playback-url">Playback URL</Field.FieldLabel>
              <Input
                id="playback-url"
                type="url"
                bind:value={runtimeDraft.playbackUrl}
                disabled={!runtime.writable}
                oninput={() => (runtimeValidated = false)}
              />
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="public-url">Public URL</Field.FieldLabel>
              <Input
                id="public-url"
                type="url"
                bind:value={runtimeDraft.publicUrl}
                disabled={!runtime.writable}
                oninput={() => (runtimeValidated = false)}
              />
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="proxy-cidrs">Trusted proxy CIDRs</Field.FieldLabel>
              <Input
                id="proxy-cidrs"
                bind:value={trustedProxyCidrs}
                placeholder="10.0.0.0/8, 192.168.1.10/32"
                disabled={!runtime.writable}
                oninput={() => (runtimeValidated = false)}
              />
              <Field.FieldDescription>
                Comma-separated. Leave empty unless traffic actually passes through those proxies.
              </Field.FieldDescription>
            </Field.Field>
          </Field.FieldGroup>
        </section>
        <section>
          <div class="heading">
            <Wrench />
            <div>
              <h2>Runtime and maintenance</h2>
              <p>Capacity, cache policy, node identity, and controlled service restart.</p>
            </div>
          </div>
          <Field.FieldGroup>
            <div class="two">
              <Field.Field>
                <Field.FieldLabel for="node-name">Node name</Field.FieldLabel>
                <Input
                  id="node-name"
                  bind:value={runtimeDraft.nodeName}
                  disabled={!runtime.writable}
                  oninput={() => (runtimeValidated = false)}
                />
              </Field.Field>
              <Field.Field>
                <Field.FieldLabel for="node-region">Node region</Field.FieldLabel>
                <Input
                  id="node-region"
                  bind:value={runtimeDraft.nodeRegion}
                  disabled={!runtime.writable}
                  oninput={() => (runtimeValidated = false)}
                />
              </Field.Field>
            </div>
            <div class="two">
              <Field.Field>
                <Field.FieldLabel for="max-workers">Concurrent encoders</Field.FieldLabel>
                <Input
                  id="max-workers"
                  type="number"
                  min="1"
                  max="32"
                  bind:value={runtimeDraft.maxWorkers}
                  disabled={!runtime.writable}
                  oninput={() => (runtimeValidated = false)}
                />
              </Field.Field>
              <Field.Field>
                <Field.FieldLabel for="cache-ttl">Cache retention (milliseconds)</Field.FieldLabel>
                <Input
                  id="cache-ttl"
                  type="number"
                  min="1000"
                  bind:value={runtimeDraft.cacheTtlMs}
                  disabled={!runtime.writable}
                  oninput={() => (runtimeValidated = false)}
                />
              </Field.Field>
            </div>
            <Field.Field>
              <Field.FieldLabel for="cache-limit">Cache limit (bytes)</Field.FieldLabel>
              <Input
                id="cache-limit"
                type="number"
                min="1"
                bind:value={runtimeDraft.cacheLimitBytes}
                disabled={!runtime.writable}
                oninput={() => (runtimeValidated = false)}
              />
            </Field.Field>
            <div class="runtime-summary">
              <span>Version <strong>{runtime.version}</strong></span>
              <span>Mode <strong>{runtime.environment}</strong></span>
              <span
                >Configuration
                <strong>{runtime.writable ? 'managed here' : 'deployment-managed'}</strong></span
              >
            </div>
            {#if !runtime.writable}
              <Alert.Root>
                <Alert.Title>Read-only deployment configuration</Alert.Title>
                <Alert.Description>
                  This installation is controlled by environment or orchestration settings. Values
                  are visible here, but must be changed in that deployment.
                </Alert.Description>
              </Alert.Root>
            {:else if runtime.restartRequired}
              <Alert.Root>
                <Alert.Title>Restart required</Alert.Title>
                <Alert.Description>
                  Saved configuration is staged. Restart to activate the new listeners and runtime
                  limits.
                </Alert.Description>
              </Alert.Root>
            {/if}
            <div class="configuration-actions">
              <Button
                variant="outline"
                disabled={!runtime.writable || validatingRuntime || savingRuntime}
                onclick={() => void validateRuntime()}
                >{#if validatingRuntime}<LoaderCircle class="animate-spin" />{:else}<RefreshCw
                  />{/if}Test configuration</Button
              >
              <Button
                disabled={!runtime.writable || !runtimeValidated || savingRuntime}
                onclick={() => void saveRuntime()}
                >{#if savingRuntime}<LoaderCircle class="animate-spin" />{:else}<Save />{/if}Save
                changes</Button
              >
              <Button
                variant="outline"
                disabled={!runtime.restartSupported ||
                  !runtime.restartRequired ||
                  restartingRuntime}
                onclick={() => void restartRuntime()}
                >{#if restartingRuntime}<LoaderCircle class="animate-spin" />{:else}<RefreshCw
                  />{/if}Restart relay</Button
              >
            </div>
          </Field.FieldGroup>
        </section>
      </div>
    {/if}
  </div></AppShell
>

<Dialog.Root
  open={Boolean(pendingProvider)}
  onOpenChange={(open) => !open && !deletingProvider && (pendingProvider = null)}
>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Remove Jellyfin connection?</Dialog.Title>
      <Dialog.Description>
        This deletes the stored credential for “{pendingProvider?.name}”. Existing relay sessions
        and worker bindings must be removed first.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" disabled={deletingProvider} onclick={() => (pendingProvider = null)}
        >Cancel</Button
      >
      <Button
        variant="destructive"
        disabled={deletingProvider}
        onclick={() => void removeProvider()}
      >
        {#if deletingProvider}<LoaderCircle
            data-icon="inline-start"
            class="animate-spin"
          />{:else}<Trash2 data-icon="inline-start" />{/if}
        {deletingProvider ? 'Removing…' : 'Remove connection'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .page {
    padding: 34px 38px;
  }
  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .columns > section,
  .configuration-grid > section {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    padding: 21px;
  }
  .heading {
    display: flex;
    gap: 11px;
    margin-bottom: 20px;
  }
  .heading > :global(svg) {
    width: 19px;
    color: var(--primary);
  }
  h2 {
    font-size: 15px;
  }
  .heading p {
    margin-top: 4px;
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .provider {
    display: grid;
    grid-template-columns: 8px 1fr auto auto auto;
    align-items: center;
    gap: 10px;
    margin-bottom: 17px;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 11px;
  }
  .provider > span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--destructive);
  }
  .provider > span.healthy {
    background: var(--success);
  }
  .provider strong,
  .toggle strong,
  .token strong {
    font-size: 11px;
  }
  .provider small,
  .toggle small {
    display: block;
    margin-top: 3px;
    color: var(--muted-foreground);
    font-size: 9px;
  }
  .provider code,
  .token code {
    font-family: ui-monospace, monospace;
    font-size: 9px;
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .scope-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 10px 12px;
  }
  .token {
    display: flex;
    flex-direction: column;
    gap: 9px;
    border: 1px solid color-mix(in oklab, var(--warning) 45%, var(--border));
    border-radius: 7px;
    background: color-mix(in oklab, var(--warning) 7%, transparent);
    padding: 13px;
  }
  .token code {
    overflow-wrap: anywhere;
    color: var(--warning);
  }
  .token-list {
    display: grid;
    margin-top: 16px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 7px;
  }
  .token-list article {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--border);
    padding: 10px 12px;
  }
  .token-list article:last-child {
    border-bottom: 0;
  }
  .token-list small {
    display: block;
    margin-top: 3px;
    color: var(--muted-foreground);
    font-size: 9px;
  }
  .token-list > article > span {
    color: var(--success);
    font-size: 9px;
  }
  .token-list > article > span.revoked {
    color: var(--muted-foreground);
  }
  .empty {
    padding: 20px;
    color: var(--muted-foreground);
    font-size: 10px;
    text-align: center;
  }
  .configuration-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-top: 16px;
  }
  .runtime-summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .runtime-summary span {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    color: var(--muted-foreground);
    font-size: 9px;
  }
  .runtime-summary strong {
    display: block;
    margin-top: 4px;
    color: var(--foreground);
    font-size: 11px;
  }
  .configuration-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  @media (max-width: 900px) {
    .columns,
    .configuration-grid {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 650px) {
    .page {
      padding: 24px 16px;
    }
    .two {
      grid-template-columns: 1fr;
    }
    .runtime-summary {
      grid-template-columns: 1fr;
    }
    .scope-list {
      grid-template-columns: 1fr;
    }
    .provider {
      grid-template-columns: 8px 1fr auto;
    }
    .provider code {
      grid-column: 2;
    }
  }
</style>
