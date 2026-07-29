<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft, FlaskConical } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { Profile } from '@vrrelay/domain';
  import { api, isAuthenticatedError } from '#lib/api';
  import { adminRoute, loginRoute } from '#lib/new-ui/state.svelte';
  import PageHeader from '#lib/new-ui/components/PageHeader.svelte';
  import LoadState from '#lib/new-ui/components/LoadState.svelte';
  import { Button } from '#lib/new-ui/components/ui/button';
  import * as Alert from '#lib/new-ui/components/ui/alert';
  import * as Card from '#lib/new-ui/components/ui/card';
  import * as Field from '#lib/new-ui/components/ui/field';
  import { Input } from '#lib/new-ui/components/ui/input';
  import * as Select from '#lib/new-ui/components/ui/select';
  import { Switch } from '#lib/new-ui/components/ui/switch';

  let profiles = $state<Profile[]>([]);
  let editingId = $state('');
  let duplicateId = $state('');
  let name = $state('New profile');
  let description = $state('');
  let profileState = $state<Profile['state']>('experimental');
  let platform = $state<Profile['platform']>('universal');
  let codec = $state<'h264' | 'h265' | 'av1' | 'copy'>('h264');
  let decodeMode = $state<Profile['video']['decodeMode']>('auto');
  let videoProfile = $state('high');
  let videoLevel = $state('');
  let pixelFormat = $state('yuv420p');
  let bitrate = $state(8000);
  let maxrate = $state(9000);
  let buffer = $state(16000);
  let width = $state(1920);
  let height = $state(1080);
  let frameRate = $state(30);
  let gop = $state(60);
  let bFrames = $state(0);
  let quality = $state('');
  let preset = $state('veryfast');
  let tune = $state('');
  let audioCodec = $state<Profile['audio']['codec']>('aac');
  let audioChannels = $state(2);
  let audioLayout = $state('stereo');
  let sampleRate = $state(48000);
  let audioBitrate = $state(192);
  let defaultAudioLanguage = $state('eng');
  let method = $state<Profile['delivery']['method']>('hls');
  let container = $state<Profile['delivery']['container']>('mpegts');
  let playlistType = $state<Profile['delivery']['playlistType']>('vod');
  let segmentDuration = $state(4);
  let latencyMode = $state<Profile['delivery']['latencyMode']>('standard');
  let toneMap = $state(false);
  let burnSubtitles = $state(false);
  let passthrough = $state<Profile['processing']['passthrough']>('never');
  let profileMaxWorkers = $state(2);
  let saving = $state(false);
  let loading = $state(true);
  let loadError = $state('');
  let step = $state(0);
  const steps = ['Basics', 'Video', 'Audio & delivery', 'Processing & review'];
  const deliveryMethods: Array<Profile['delivery']['method']> = ['hls'];
  let pageTitle = $derived(
    editingId ? 'Edit profile' : duplicateId ? 'Duplicate profile' : 'New profile'
  );

  onMount(async () => {
    try {
      const profileResult = await api.profiles();
      profiles = profileResult.items;
      editingId = page.url.searchParams.get('edit') ?? '';
      duplicateId = page.url.searchParams.get('duplicate') ?? '';
      const source = profiles.find((profile) => profile.profileId === (editingId || duplicateId));
      if ((editingId || duplicateId) && !source) throw new Error('Profile was not found.');
      if (source) loadProfile(source, Boolean(duplicateId));
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(loginRoute(page.url.pathname));
      loadError = reason instanceof Error ? reason.message : 'Could not load profiles.';
    } finally {
      loading = false;
    }
  });

  function loadProfile(profile: Profile, duplicate: boolean) {
    name = duplicate ? `${profile.name} copy` : profile.name;
    description = profile.description ?? '';
    profileState = duplicate ? 'experimental' : profile.state;
    platform = profile.platform;
    codec = profile.video.codec;
    decodeMode = profile.video.decodeMode;
    videoProfile = profile.video.profile ?? '';
    videoLevel = profile.video.level ?? '';
    pixelFormat = profile.video.pixelFormat;
    bitrate = profile.video.bitrateKbps;
    maxrate = profile.video.maxrateKbps;
    buffer = profile.video.bufferKbps;
    width = profile.video.width;
    height = profile.video.height;
    frameRate = profile.video.frameRate;
    gop = profile.video.gop;
    bFrames = profile.video.bFrames;
    quality = profile.video.quality?.toString() ?? '';
    preset = profile.video.preset ?? '';
    tune = profile.video.tune ?? '';
    audioCodec = profile.audio.codec;
    audioChannels = profile.audio.channels;
    audioLayout = profile.audio.layout;
    sampleRate = profile.audio.sampleRate;
    audioBitrate = profile.audio.bitrateKbps;
    defaultAudioLanguage = profile.audio.defaultLanguage ?? 'eng';
    method = profile.delivery.method;
    container = profile.delivery.container;
    playlistType = profile.delivery.playlistType;
    segmentDuration = profile.delivery.segmentDuration;
    latencyMode = profile.delivery.latencyMode;
    toneMap = profile.processing.toneMap;
    burnSubtitles = profile.processing.burnSubtitles;
    passthrough = profile.processing.passthrough;
    profileMaxWorkers = profile.processing.maxWorkers;
  }

  function deliveryContainerOptions(): Array<Profile['delivery']['container']> {
    return ['mpegts', 'fmp4'];
  }

  $effect(() => {
    const options = deliveryContainerOptions();
    if (!options.includes(container)) container = options[0] ?? 'mpegts';
    latencyMode = 'standard';
    passthrough = 'never';
  });

  async function save() {
    saving = true;
    try {
      const input = {
        name,
        description: description.trim() || undefined,
        platform,
        state: profileState === 'verified' ? 'verified' : 'experimental',
        video: {
          codec,
          decodeMode,
          profile: videoProfile.trim() || undefined,
          level: videoLevel.trim() || undefined,
          pixelFormat,
          bitrateKbps: Number(bitrate),
          maxrateKbps: Number(maxrate),
          bufferKbps: Number(buffer),
          width: Number(width),
          height: Number(height),
          frameRate: Number(frameRate),
          gop: Number(gop),
          bFrames: Number(bFrames),
          quality: quality.trim() ? Number(quality) : undefined,
          preset: preset.trim() || undefined,
          tune: tune.trim() || undefined
        },
        audio: {
          codec: audioCodec,
          channels: Number(audioChannels),
          layout: audioLayout,
          sampleRate: Number(sampleRate),
          bitrateKbps: Number(audioBitrate),
          defaultLanguage: defaultAudioLanguage.trim().toLowerCase() || undefined
        },
        delivery: {
          method,
          container,
          segmentType: container === 'fmp4' ? 'fmp4' : 'mpegts',
          segmentDuration: Number(segmentDuration),
          latencyMode,
          playlistType
        },
        processing: {
          toneMap,
          burnSubtitles,
          passthrough,
          maxWorkers: Number(profileMaxWorkers)
        }
      } satisfies import('@vrrelay/contracts').ProfileInput;
      if (editingId) await api.updateProfile(editingId, input);
      else await api.createProfile(input);
      toast.success(editingId ? 'Profile updated.' : 'Profile created.');
      await goto('/dashboard/settings/profiles');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not create profile.');
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-6 p-4 md:p-6">
  <PageHeader
    title={pageTitle}
    description="Configure a structured media profile, then test it in VRChat."
    >{#snippet actions()}<Button variant="outline" href="/dashboard/settings/profiles"
        ><ArrowLeft data-icon="inline-start" />Profiles</Button
      >{/snippet}</PageHeader
  >
  <LoadState {loading} error={loadError} label="profile editor" variant="form" />
  {#if !loading && !loadError}
    <Alert.Root
      ><FlaskConical /><Alert.Title>Compatibility experiment</Alert.Title><Alert.Description
        >Every setting is validated. VRRelay never accepts raw FFmpeg arguments.</Alert.Description
      ></Alert.Root
    >
    <nav class="grid grid-cols-2 gap-2 xl:grid-cols-4" aria-label="Profile creation steps">
      {#each steps as label, index}
        <Button variant={step === index ? 'default' : 'outline'} onclick={() => (step = index)}>
          {index + 1}. {label}
        </Button>
      {/each}
    </nav>
    <div class="grid gap-4">
      <Card.Root class={step !== 0 ? 'hidden' : ''}
        ><Card.Header
          ><Card.Title>Identity</Card.Title><Card.Description
            >Name the profile and choose its target platform and codec.</Card.Description
          ></Card.Header
        ><Card.Content
          ><Field.Group
            ><Field.Field
              ><Field.Label for="profile-name">Profile name</Field.Label><Input
                id="profile-name"
                bind:value={name}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="profile-description">Description</Field.Label><Input
                id="profile-description"
                maxlength={500}
                placeholder="What this profile is intended to support"
                bind:value={description}
              /><Field.Description
                >Shown to administrators when choosing and reviewing profiles.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="profile-platform">Platform</Field.Label><Select.Root
                type="single"
                bind:value={platform}
                ><Select.Trigger id="profile-platform" class="w-full">{platform}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    >{#each ['universal', 'pc', 'quest', 'dual'] as value}<Select.Item {value}
                        >{value}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ><Field.Field
              ><Field.Label for="profile-codec">Video codec</Field.Label><Select.Root
                type="single"
                value={codec}
                onValueChange={(value) => (codec = (value ?? 'h264') as typeof codec)}
                ><Select.Trigger id="profile-codec" class="w-full"
                  >{codec.toUpperCase()}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    >{#each ['h264', 'h265', 'av1', 'copy'] as value}<Select.Item {value}
                        >{value.toUpperCase()}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ></Field.Group
          ></Card.Content
        ></Card.Root
      >
      <Card.Root class={step !== 1 ? 'hidden' : ''}
        ><Card.Header
          ><Card.Title>Video</Card.Title><Card.Description
            >Structured rate-control and output geometry settings.</Card.Description
          ></Card.Header
        ><Card.Content
          ><Field.Group class="grid sm:grid-cols-2"
            ><Field.Field
              ><Field.Label for="decode-mode">Decode acceleration</Field.Label><Select.Root
                type="single"
                bind:value={decodeMode}
                ><Select.Trigger id="decode-mode" class="w-full">{decodeMode}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    >{#each ['auto', 'software', 'videotoolbox', 'd3d11va', 'qsv', 'vaapi', 'cuda'] as value}<Select.Item
                        {value}>{value}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ><Field.Field
              ><Field.Label for="pixel-format">Pixel format</Field.Label><Input
                id="pixel-format"
                bind:value={pixelFormat}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="video-profile">Codec profile</Field.Label><Input
                id="video-profile"
                placeholder="high"
                bind:value={videoProfile}
              /><Field.Description
                >A validated encoder profile name. Leave blank to use the encoder default.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="video-level">Codec level</Field.Label><Input
                id="video-level"
                placeholder="4.1"
                bind:value={videoLevel}
              /><Field.Description
                >Leave blank unless the target player requires a specific codec level.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="video-width">Width</Field.Label><Input
                id="video-width"
                type="number"
                min="16"
                bind:value={width}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="video-height">Height</Field.Label><Input
                id="video-height"
                type="number"
                min="16"
                bind:value={height}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="frame-rate">Frame rate</Field.Label><Input
                id="frame-rate"
                type="number"
                min="1"
                bind:value={frameRate}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="video-bitrate">Bitrate (kbps)</Field.Label><Input
                id="video-bitrate"
                type="number"
                min="1"
                bind:value={bitrate}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="video-maxrate">Maximum bitrate (kbps)</Field.Label><Input
                id="video-maxrate"
                type="number"
                min="1"
                bind:value={maxrate}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="video-buffer">Rate-control buffer (kb)</Field.Label><Input
                id="video-buffer"
                type="number"
                min="1"
                bind:value={buffer}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="video-gop">GOP frames</Field.Label><Input
                id="video-gop"
                type="number"
                min="1"
                bind:value={gop}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="video-bframes">B-frames</Field.Label><Input
                id="video-bframes"
                type="number"
                min="0"
                max="16"
                bind:value={bFrames}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="video-quality">Encoder quality</Field.Label><Input
                id="video-quality"
                type="number"
                min="0"
                max="63"
                placeholder="Encoder default"
                bind:value={quality}
              /><Field.Description
                >Optional codec-specific quality value from 0 to 63.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="video-preset">Encoder preset</Field.Label><Input
                id="video-preset"
                placeholder="veryfast"
                bind:value={preset}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="video-tune">Encoder tune</Field.Label><Input
                id="video-tune"
                placeholder="Encoder default"
                bind:value={tune}
              /></Field.Field
            ></Field.Group
          ></Card.Content
        ></Card.Root
      >
      <Card.Root class={step !== 2 ? 'hidden' : ''}
        ><Card.Header
          ><Card.Title>Audio and delivery</Card.Title><Card.Description
            >Audio layout and the implemented finite HLS delivery shape.</Card.Description
          ></Card.Header
        ><Card.Content
          ><Field.Group class="grid sm:grid-cols-2"
            ><Field.Field
              ><Field.Label for="audio-codec">Audio codec</Field.Label><Select.Root
                type="single"
                bind:value={audioCodec}
                ><Select.Trigger id="audio-codec" class="w-full"
                  >{audioCodec.toUpperCase()}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    >{#each ['aac', 'opus', 'ac3', 'copy'] as value}<Select.Item {value}
                        >{value.toUpperCase()}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ><Field.Field
              ><Field.Label for="audio-channels">Channels</Field.Label><Input
                id="audio-channels"
                type="number"
                min="1"
                bind:value={audioChannels}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="audio-layout">Channel layout</Field.Label><Input
                id="audio-layout"
                bind:value={audioLayout}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="audio-sample-rate">Sample rate (Hz)</Field.Label><Input
                id="audio-sample-rate"
                type="number"
                min="8000"
                bind:value={sampleRate}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="audio-bitrate">Audio bitrate (kbps)</Field.Label><Input
                id="audio-bitrate"
                type="number"
                min="1"
                bind:value={audioBitrate}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="audio-default-language">Default audio language</Field.Label><Input
                id="audio-default-language"
                bind:value={defaultAudioLanguage}
                placeholder="eng"
              /><Field.Description
                >ISO 639-2 or BCP-47 preference when a relay does not select a track explicitly. The
                selected source track still overrides this.</Field.Description
              ></Field.Field
            ><Field.Field
              ><Field.Label for="delivery-method">Delivery method</Field.Label><Select.Root
                type="single"
                bind:value={method}
                ><Select.Trigger id="delivery-method" class="w-full"
                  >{method.replace('_', ' ')}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    >{#each deliveryMethods as value}<Select.Item {value}
                        >{value.replace('_', ' ')}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ><Field.Field
              ><Field.Label for="delivery-container">Container</Field.Label><Select.Root
                type="single"
                bind:value={container}
                ><Select.Trigger id="delivery-container" class="w-full">{container}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    >{#each deliveryContainerOptions() as value}<Select.Item {value}
                        >{value}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ><Field.Field
              ><Field.Label for="playlist-type">Playlist type</Field.Label><Select.Root
                type="single"
                bind:value={playlistType}
                ><Select.Trigger id="playlist-type" class="w-full">{playlistType}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    ><Select.Item value="vod">VOD</Select.Item><Select.Item value="live"
                      >Live</Select.Item
                    ></Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ><Field.Field
              ><Field.Label for="segment-duration">Segment duration (seconds)</Field.Label><Input
                id="segment-duration"
                type="number"
                min="1"
                bind:value={segmentDuration}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="latency-mode">Latency mode</Field.Label><Select.Root
                type="single"
                bind:value={latencyMode}
                ><Select.Trigger id="latency-mode" class="w-full">{latencyMode}</Select.Trigger
                ><Select.Content
                  ><Select.Group><Select.Item value="standard">Standard</Select.Item></Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ></Field.Group
          ></Card.Content
        ></Card.Root
      >
      <Card.Root class={step !== 3 ? 'hidden' : ''}
        ><Card.Header><Card.Title>Processing</Card.Title></Card.Header><Card.Content
          ><Field.Group
            ><Field.Field orientation="horizontal"
              ><Field.Content
                ><Field.Title>Tone map HDR sources</Field.Title><Field.Description
                  >Normalize HDR sources through the selected filter path.</Field.Description
                ></Field.Content
              ><Switch aria-label="Tone map HDR sources" bind:checked={toneMap} /></Field.Field
            ><Field.Field orientation="horizontal"
              ><Field.Content
                ><Field.Title>Burn selected subtitles</Field.Title><Field.Description
                  >Render subtitles into video and disable video copy.</Field.Description
                ></Field.Content
              ><Switch
                aria-label="Burn selected subtitles"
                bind:checked={burnSubtitles}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="passthrough-policy">Passthrough policy</Field.Label><Select.Root
                type="single"
                bind:value={passthrough}
                ><Select.Trigger id="passthrough-policy" class="w-full"
                  >{passthrough}</Select.Trigger
                ><Select.Content
                  ><Select.Group><Select.Item value="never">Never</Select.Item></Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ><Field.Field
              ><Field.Label for="profile-max-workers">Workers per session</Field.Label><Input
                id="profile-max-workers"
                type="number"
                min="1"
                max="32"
                bind:value={profileMaxWorkers}
              /><Field.Description
                >Maximum worker capacity this profile may use for one session.</Field.Description
              ></Field.Field
            ></Field.Group
          ></Card.Content
        ></Card.Root
      >
    </div>
    <div class="flex justify-between gap-2">
      <Button variant="outline" disabled={step === 0} onclick={() => (step -= 1)}>Back</Button>
      {#if step < steps.length - 1}
        <Button disabled={!name.trim()} onclick={() => (step += 1)}>Continue</Button>
      {:else}
        <Button disabled={!name.trim() || saving} onclick={save}
          >{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create profile'}</Button
        >
      {/if}
    </div>
  {/if}
</div>
