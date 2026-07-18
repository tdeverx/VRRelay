<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Plus } from '@lucide/svelte';
  import type { ProfileRevision } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import { adminRoute } from '#lib/new-ui/state.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import StatusBadge from '#lib/new-ui/components/StatusBadge.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Table from '#lib/new-ui/components/ui/table';

  let profiles = $state<ProfileRevision[]>([]);
  let loading = $state(true);
  let error = $state('');
  onMount(async () => {
    try {
      profiles = (await api.profiles()).items;
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(adminRoute(page.url.pathname, '/login'));
      error = reason instanceof Error ? reason.message : 'Could not load profiles.';
    } finally {
      loading = false;
    }
  });
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title="Profiles"
    description="Versioned encoding and delivery presets shared by every relay."
  >
    {#snippet actions()}<Button href={adminRoute(page.url.pathname, '/profiles/new')}
        ><Plus data-icon="inline-start" />New profile</Button
      >{/snippet}
  </PageHeader>
  <LoadState
    {loading}
    {error}
    empty={!loading && !error && profiles.length === 0}
    label="profiles"
  />
  {#if !loading && !error && profiles.length}
    <div class="hidden overflow-hidden rounded-xl border md:block">
      <Table.Root
        ><Table.Header
          ><Table.Row
            ><Table.Head>Name</Table.Head><Table.Head>Revision</Table.Head><Table.Head
              >Platform</Table.Head
            ><Table.Head>Video</Table.Head><Table.Head>Delivery</Table.Head><Table.Head
              >Status</Table.Head
            ></Table.Row
          ></Table.Header
        >
        <Table.Body
          >{#each profiles as profile}<Table.Row
              ><Table.Cell class="font-medium">{profile.name}</Table.Cell><Table.Cell
                >{profile.revision}</Table.Cell
              ><Table.Cell>{profile.platform}</Table.Cell><Table.Cell
                >{profile.video.codec} · {profile.video.width}×{profile.video.height}</Table.Cell
              ><Table.Cell>{profile.delivery.playlistType}</Table.Cell><Table.Cell
                ><StatusBadge value={profile.state ?? 'experimental'} /></Table.Cell
              ></Table.Row
            >{/each}</Table.Body
        >
      </Table.Root>
    </div>
    <div class="grid gap-3 md:hidden">
      {#each profiles as profile}<Card.Root
          ><Card.Header
            ><Card.Title>{profile.name}</Card.Title><Card.Description
              >Revision {profile.revision} · {profile.platform}</Card.Description
            ><Card.Action><StatusBadge value={profile.state ?? 'experimental'} /></Card.Action
            ></Card.Header
          ><Card.Content class="text-sm"
            >{profile.video.codec} · {profile.video.width}×{profile.video.height} · {profile
              .delivery.playlistType}</Card.Content
          ></Card.Root
        >{/each}
    </div>
  {/if}
</div>
