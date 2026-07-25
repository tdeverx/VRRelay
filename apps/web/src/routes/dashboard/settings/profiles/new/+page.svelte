<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft, FlaskConical } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { ProfileRevision } from '@vrrelay/domain';
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

  let profiles = $state<ProfileRevision[]>([]);
  let encoders = $state<
    Array<{ name: string; codec: string; hardware: boolean; available: boolean }>
  >([]);
  let baseKey = $state('');
  let name = $state('Compatibility experiment');
  let codec = $state<'h264' | 'h265' | 'av1' | 'copy'>('h264');
  let encoder = $state('libx264');
  let hardwareMode = $state<ProfileRevision['video']['hardwareMode']>('software');
  let decodeMode = $state<ProfileRevision['video']['decodeMode']>('auto');
  let pixelFormat = $state('yuv420p');
  let bitrate = $state(8000);
  let maxrate = $state(9000);
  let buffer = $state(16000);
  let width = $state(1920);
  let height = $state(1080);
  let frameRate = $state(30);
  let gop = $state(60);
  let bFrames = $state(0);
  let audioCodec = $state<ProfileRevision['audio']['codec']>('aac');
  let audioChannels = $state(2);
  let audioLayout = $state('stereo');
  let sampleRate = $state(48000);
  let audioBitrate = $state(192);
  let defaultAudioLanguage = $state('eng');
  let method = $state<ProfileRevision['delivery']['method']>('hls');
  let container = $state<ProfileRevision['delivery']['container']>('mpegts');
  let segmentDuration = $state(4);
  let latencyMode = $state<ProfileRevision['delivery']['latencyMode']>('standard');
  let toneMap = $state(false);
  let burnSubtitles = $state(false);
  let passthrough = $state<ProfileRevision['processing']['passthrough']>('never');
  let saving = $state(false);
  let loading = $state(true);
  let loadError = $state('');
  let step = $state(0);
  const steps = ['Basics', 'Video', 'Audio & delivery', 'Processing & review'];
  const deliveryMethods: Array<ProfileRevision['delivery']['method']> = ['hls'];
  let base = $derived(
    profiles.find((profile) => `${profile.profileId}:${profile.revision}` === baseKey)
  );

  onMount(async () => {
    try {
      const [profileResult, capabilityResult] = await Promise.all([
        api.profiles(),
        api.capabilities()
      ]);
      profiles = profileResult.items;
      encoders = capabilityResult.encoders;
      if (profiles[0]) selectBase(`${profiles[0].profileId}:${profiles[0].revision}`);
    } catch (reason) {
      if (isAuthenticatedError(reason)) return goto(loginRoute(page.url.pathname));
      loadError = reason instanceof Error ? reason.message : 'Could not load profiles.';
    } finally {
      loading = false;
    }
  });

  function selectBase(value: string) {
    baseKey = value;
    const profile = profiles.find((item) => `${item.profileId}:${item.revision}` === value);
    if (!profile) return;
    name = `${profile.name} experiment`;
    codec = profile.video.codec;
    encoder = profile.video.encoder;
    hardwareMode = profile.video.hardwareMode;
    decodeMode = profile.video.decodeMode;
    pixelFormat = profile.video.pixelFormat;
    bitrate = profile.video.bitrateKbps;
    maxrate = profile.video.maxrateKbps;
    buffer = profile.video.bufferKbps;
    width = profile.video.width;
    height = profile.video.height;
    frameRate = profile.video.frameRate;
    gop = profile.video.gop;
    bFrames = profile.video.bFrames;
    audioCodec = profile.audio.codec;
    audioChannels = profile.audio.channels;
    audioLayout = profile.audio.layout;
    sampleRate = profile.audio.sampleRate;
    audioBitrate = profile.audio.bitrateKbps;
    defaultAudioLanguage = profile.audio.defaultLanguage ?? 'eng';
    method = profile.delivery.method;
    container = profile.delivery.container;
    segmentDuration = profile.delivery.segmentDuration;
    latencyMode = profile.delivery.latencyMode;
    toneMap = profile.processing.toneMap;
    burnSubtitles = profile.processing.burnSubtitles;
    passthrough = profile.processing.passthrough;
  }

  function selectCodec(value: string) {
    codec = value as typeof codec;
    const available = encoders.find((item) => item.codec === codec && item.available);
    if (!available) return;
    encoder = available.name;
    hardwareMode = available.name.includes('videotoolbox')
      ? 'videotoolbox'
      : available.name.includes('nvenc')
        ? 'nvenc'
        : available.name.includes('qsv')
          ? 'qsv'
          : available.name.includes('vaapi')
            ? 'vaapi'
            : available.name.includes('amf')
              ? 'amf'
              : 'software';
  }

  function deliveryContainerOptions(): Array<ProfileRevision['delivery']['container']> {
    return ['mpegts', 'fmp4'];
  }

  $effect(() => {
    const options = deliveryContainerOptions();
    if (!options.includes(container)) container = options[0] ?? 'mpegts';
    latencyMode = 'standard';
    passthrough = 'never';
  });

  async function save() {
    if (!base) return;
    saving = true;
    try {
      const revision = await api.createProfileRevision({
        ...base,
        name,
        description: 'User-created compatibility experiment.',
        state: 'experimental',
        video: {
          ...base.video,
          codec,
          encoder,
          hardwareMode,
          decodeMode,
          pixelFormat,
          bitrateKbps: Number(bitrate),
          maxrateKbps: Number(maxrate),
          bufferKbps: Number(buffer),
          width: Number(width),
          height: Number(height),
          frameRate: Number(frameRate),
          gop: Number(gop),
          bFrames: Number(bFrames)
        },
        audio: {
          ...base.audio,
          codec: audioCodec,
          channels: Number(audioChannels),
          layout: audioLayout,
          sampleRate: Number(sampleRate),
          bitrateKbps: Number(audioBitrate),
          defaultLanguage: defaultAudioLanguage.trim().toLowerCase() || undefined
        },
        delivery: {
          ...base.delivery,
          method,
          container,
          segmentType: container === 'fmp4' ? 'fmp4' : 'mpegts',
          segmentDuration: Number(segmentDuration),
          latencyMode,
          playlistType: method === 'hls' ? base.delivery.playlistType : 'vod'
        },
        processing: { ...base.processing, toneMap, burnSubtitles, passthrough }
      });
      toast.success(`Created revision ${revision.revision}.`);
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
    title="New profile revision"
    description="Clone a known profile, tune its structured pipeline, then test it in VRChat."
    >{#snippet actions()}<Button variant="outline" href="/dashboard/settings/profiles"
        ><ArrowLeft data-icon="inline-start" />Profiles</Button
      >{/snippet}</PageHeader
  >
  <LoadState {loading} error={loadError} label="profile editor" variant="form" />
  {#if !loading && !loadError}
    <Alert.Root
      ><FlaskConical /><Alert.Title>Compatibility experiment</Alert.Title><Alert.Description
        >Every setting is validated and immutable. VRRelay never accepts raw FFmpeg arguments.</Alert.Description
      ></Alert.Root
    >
    <nav class="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Profile creation steps">
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
            >Start from an existing immutable profile.</Card.Description
          ></Card.Header
        ><Card.Content
          ><Field.Group
            ><Field.Field
              ><Field.Label>Base revision</Field.Label><Select.Root
                type="single"
                value={baseKey}
                onValueChange={(value) => selectBase(value ?? '')}
                ><Select.Trigger class="w-full">{base?.name ?? 'Select profile'}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    >{#each profiles as profile}<Select.Item
                        value={`${profile.profileId}:${profile.revision}`}
                        >{profile.name} · r{profile.revision}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            ><Field.Field
              ><Field.Label for="profile-name">Revision name</Field.Label><Input
                id="profile-name"
                bind:value={name}
              /></Field.Field
            ><Field.Field
              ><Field.Label for="profile-codec">Video codec</Field.Label><Select.Root
                type="single"
                value={codec}
                onValueChange={(value) => selectCodec(value ?? 'h264')}
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
            ><Field.Field
              ><Field.Label for="profile-encoder">Encoder implementation</Field.Label><Select.Root
                type="single"
                bind:value={encoder}
                ><Select.Trigger id="profile-encoder" class="w-full">{encoder}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    >{#each encoders.filter((item) => item.codec === codec) as item}<Select.Item
                        value={item.name}
                        disabled={!item.available}
                        >{item.name}{item.available ? '' : ' · unavailable'}</Select.Item
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
            >Structured encoder, rate-control and output geometry settings.</Card.Description
          ></Card.Header
        ><Card.Content
          ><Field.Group class="grid sm:grid-cols-2"
            ><Field.Field
              ><Field.Label for="hardware-mode">Hardware mode</Field.Label><Select.Root
                type="single"
                bind:value={hardwareMode}
                ><Select.Trigger id="hardware-mode" class="w-full">{hardwareMode}</Select.Trigger
                ><Select.Content
                  ><Select.Group
                    >{#each ['auto', 'software', 'videotoolbox', 'qsv', 'vaapi', 'nvenc', 'amf'] as value}<Select.Item
                        {value}>{value}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                ></Select.Root
              ></Field.Field
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
                bind:value={bFrames}
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
            ></Field.Group
          ></Card.Content
        ></Card.Root
      >
    </div>
    <div class="flex justify-between gap-2">
      <Button variant="outline" disabled={step === 0} onclick={() => (step -= 1)}>Back</Button>
      {#if step < steps.length - 1}
        <Button disabled={!base || !name.trim()} onclick={() => (step += 1)}>Continue</Button>
      {:else}
        <Button disabled={!base || !name.trim() || saving} onclick={save}
          >{saving ? 'Creating…' : 'Create profile revision'}</Button
        >
      {/if}
    </div>
  {/if}
</div>
