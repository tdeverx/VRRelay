<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { ArrowLeft, FlaskConical } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import type { ProfileRevision } from '@vrrelay/domain';
  import AppShell from '$lib/components/AppShell.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { api, isAuthenticatedError } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Field from '$lib/components/ui/field';
  import * as Select from '$lib/components/ui/select';
  import * as Alert from '$lib/components/ui/alert';

  let profiles = $state<ProfileRevision[]>([]);
  let encoders = $state<
    Array<{ name: string; codec: string; hardware: boolean; available: boolean }>
  >([]);
  let baseKey = $state('');
  let name = $state('Compatibility experiment');
  let saving = $state(false);
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
  let method = $state<ProfileRevision['delivery']['method']>('hls');
  let container = $state<ProfileRevision['delivery']['container']>('mpegts');
  let segmentDuration = $state(4);
  let latencyMode = $state<ProfileRevision['delivery']['latencyMode']>('standard');
  let toneMap = $state(false);
  let burnSubtitles = $state(false);
  let passthrough = $state<ProfileRevision['processing']['passthrough']>('never');
  let base = $derived(
    profiles.find((profile) => `${profile.profileId}:${profile.revision}` === baseKey)
  );

  onMount(async () => {
    try {
      const [p, c] = await Promise.all([api.profiles(), api.capabilities()]);
      profiles = p.items;
      encoders = c.encoders;
      const first = profiles[0];
      if (first) {
        baseKey = `${first.profileId}:${first.revision}`;
        sync(first);
      }
    } catch (error) {
      if (isAuthenticatedError(error)) return goto('/login');
      toast.error(error instanceof Error ? error.message : 'Could not load profile capabilities.');
    }
  });
  function sync(p: ProfileRevision) {
    name = `${p.name} experiment`;
    codec = p.video.codec;
    encoder = p.video.encoder;
    hardwareMode = p.video.hardwareMode;
    decodeMode = p.video.decodeMode;
    pixelFormat = p.video.pixelFormat;
    bitrate = p.video.bitrateKbps;
    maxrate = p.video.maxrateKbps;
    buffer = p.video.bufferKbps;
    width = p.video.width;
    height = p.video.height;
    frameRate = p.video.frameRate;
    gop = p.video.gop;
    bFrames = p.video.bFrames;
    audioCodec = p.audio.codec;
    audioChannels = p.audio.channels;
    audioLayout = p.audio.layout;
    sampleRate = p.audio.sampleRate;
    audioBitrate = p.audio.bitrateKbps;
    method = p.delivery.method;
    container = p.delivery.container;
    segmentDuration = p.delivery.segmentDuration;
    latencyMode = p.delivery.latencyMode;
    toneMap = p.processing.toneMap;
    burnSubtitles = p.processing.burnSubtitles;
    passthrough = p.processing.passthrough;
  }
  function selectBase(value: string) {
    baseKey = value;
    const p = profiles.find((item) => `${item.profileId}:${item.revision}` === value);
    if (p) sync(p);
  }
  function selectCodec(value: string) {
    codec = value as typeof codec;
    const available = encoders.find((item) => item.codec === codec && item.available);
    if (available) {
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
  }
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
          bitrateKbps: Number(audioBitrate)
        },
        delivery: {
          ...base.delivery,
          method,
          container,
          segmentType:
            method === 'fragmented_mp4' ? 'none' : container === 'fmp4' ? 'fmp4' : 'mpegts',
          segmentDuration: Number(segmentDuration),
          latencyMode,
          playlistType: method === 'hls' ? base.delivery.playlistType : 'vod'
        },
        processing: { ...base.processing, toneMap, burnSubtitles, passthrough }
      });
      toast.success(`Created revision ${revision.revision}.`);
      goto('/profiles');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create profile revision.');
    } finally {
      saving = false;
    }
  }
</script>

<AppShell active="profiles"
  ><div class="page">
    <PageHeader
      title="New profile revision"
      description="Clone a known profile, tune its structured pipeline, then test it in VRChat."
      >{#snippet actions()}<Button variant="outline" href="/profiles"><ArrowLeft />Profiles</Button
        >{/snippet}</PageHeader
    >
    <Alert.Root
      ><FlaskConical /><Alert.Title>Compatibility experiment</Alert.Title><Alert.Description
        >Every setting is validated and immutable. VRRelay never accepts raw FFmpeg arguments.</Alert.Description
      ></Alert.Root
    >
    <section>
      <h2>Identity and primary output</h2>
      <div class="grid">
        <Field.Field
          ><Field.FieldLabel>Base revision</Field.FieldLabel><Select.Root
            type="single"
            value={baseKey}
            onValueChange={(value) => selectBase(value ?? '')}
            ><Select.Trigger>{base?.name ?? 'Select profile'}</Select.Trigger><Select.Content
              ><Select.Group
                >{#each profiles as profile}<Select.Item
                    value={`${profile.profileId}:${profile.revision}`}
                    label={profile.name}>{profile.name} · r{profile.revision}</Select.Item
                  >{/each}</Select.Group
              ></Select.Content
            ></Select.Root
          ></Field.Field
        >
        <Field.Field
          ><Field.FieldLabel>Revision name</Field.FieldLabel><Input
            bind:value={name}
          /></Field.Field
        >
        <Field.Field
          ><Field.FieldLabel>Video codec</Field.FieldLabel><Select.Root
            type="single"
            value={codec}
            onValueChange={(value) => selectCodec(value ?? 'h264')}
            ><Select.Trigger>{codec.toUpperCase()}</Select.Trigger><Select.Content
              ><Select.Group
                >{#each ['h264', 'h265', 'av1', 'copy'] as value}<Select.Item {value} label={value}
                    >{value.toUpperCase()}</Select.Item
                  >{/each}</Select.Group
              ></Select.Content
            ></Select.Root
          ></Field.Field
        >
        <Field.Field
          ><Field.FieldLabel>Encoder implementation</Field.FieldLabel><Select.Root
            type="single"
            bind:value={encoder}
            ><Select.Trigger>{encoder}</Select.Trigger><Select.Content
              ><Select.Group
                >{#each encoders.filter((item) => item.codec === codec) as item}<Select.Item
                    value={item.name}
                    label={item.name}
                    disabled={!item.available}
                    >{item.name}{item.available ? '' : ' · unavailable'}</Select.Item
                  >{/each}</Select.Group
              ></Select.Content
            ></Select.Root
          ></Field.Field
        >
        <Field.Field
          ><Field.FieldLabel>Delivery method</Field.FieldLabel><Select.Root
            type="single"
            bind:value={method}
            ><Select.Trigger>{method.replace('_', ' ')}</Select.Trigger><Select.Content
              ><Select.Group
                >{#each ['hls', 'fragmented_mp4', 'rtsp', 'mpegts_http'] as value}<Select.Item
                    {value}
                    label={value}>{value.replace('_', ' ')}</Select.Item
                  >{/each}</Select.Group
              ></Select.Content
            ></Select.Root
          ></Field.Field
        >
        <Field.Field
          ><Field.FieldLabel>Container</Field.FieldLabel><Select.Root
            type="single"
            bind:value={container}
            ><Select.Trigger>{container}</Select.Trigger><Select.Content
              ><Select.Group
                >{#each ['mpegts', 'fmp4', 'mp4'] as value}<Select.Item {value} label={value}
                    >{value}</Select.Item
                  >{/each}</Select.Group
              ></Select.Content
            ></Select.Root
          ></Field.Field
        >
      </div>

      <details>
        <summary>Video, audio, processing, and delivery controls</summary>
        <div class="control-group">
          <h3>Video pipeline</h3>
          <div class="grid compact">
            <Field.Field
              ><Field.FieldLabel>Hardware mode</Field.FieldLabel><Select.Root
                type="single"
                bind:value={hardwareMode}
                ><Select.Trigger>{hardwareMode}</Select.Trigger><Select.Content
                  >{#each ['auto', 'software', 'videotoolbox', 'qsv', 'vaapi', 'nvenc', 'amf'] as value}<Select.Item
                      {value}
                      label={value}>{value}</Select.Item
                    >{/each}</Select.Content
                ></Select.Root
              ></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Decode acceleration</Field.FieldLabel><Select.Root
                type="single"
                bind:value={decodeMode}
                ><Select.Trigger>{decodeMode}</Select.Trigger><Select.Content
                  >{#each ['auto', 'software', 'videotoolbox', 'd3d11va', 'qsv', 'vaapi', 'cuda'] as value}<Select.Item
                      {value}
                      label={value}>{value}</Select.Item
                    >{/each}</Select.Content
                ></Select.Root
              ></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Pixel format</Field.FieldLabel><Input
                bind:value={pixelFormat}
              /></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Resolution</Field.FieldLabel>
              <div class="inline">
                <Input type="number" bind:value={width} /><span>×</span><Input
                  type="number"
                  bind:value={height}
                />
              </div></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Frame rate</Field.FieldLabel><Input
                type="number"
                bind:value={frameRate}
              /></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Bitrate / max / buffer (kbps)</Field.FieldLabel>
              <div class="triple">
                <Input type="number" bind:value={bitrate} /><Input
                  type="number"
                  bind:value={maxrate}
                /><Input type="number" bind:value={buffer} />
              </div></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>GOP frames</Field.FieldLabel><Input
                type="number"
                bind:value={gop}
              /></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>B-frames</Field.FieldLabel><Input
                type="number"
                bind:value={bFrames}
              /></Field.Field
            >
          </div>
        </div>
        <div class="control-group">
          <h3>Audio and delivery</h3>
          <div class="grid compact">
            <Field.Field
              ><Field.FieldLabel>Audio codec</Field.FieldLabel><Select.Root
                type="single"
                bind:value={audioCodec}
                ><Select.Trigger>{audioCodec.toUpperCase()}</Select.Trigger><Select.Content
                  >{#each ['aac', 'opus', 'ac3', 'copy'] as value}<Select.Item {value} label={value}
                      >{value.toUpperCase()}</Select.Item
                    >{/each}</Select.Content
                ></Select.Root
              ></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Channels / layout</Field.FieldLabel>
              <div class="inline">
                <Input type="number" bind:value={audioChannels} /><Input bind:value={audioLayout} />
              </div></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Sample rate (Hz)</Field.FieldLabel><Input
                type="number"
                bind:value={sampleRate}
              /></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Audio bitrate (kbps)</Field.FieldLabel><Input
                type="number"
                bind:value={audioBitrate}
              /></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Segment duration (seconds)</Field.FieldLabel><Input
                type="number"
                bind:value={segmentDuration}
              /></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Latency mode</Field.FieldLabel><Select.Root
                type="single"
                bind:value={latencyMode}
                ><Select.Trigger>{latencyMode}</Select.Trigger><Select.Content
                  ><Select.Item value="standard" label="standard">standard</Select.Item><Select.Item
                    value="low"
                    label="low">low</Select.Item
                  ></Select.Content
                ></Select.Root
              ></Field.Field
            >
            <Field.Field
              ><Field.FieldLabel>Passthrough policy</Field.FieldLabel><Select.Root
                type="single"
                bind:value={passthrough}
                ><Select.Trigger>{passthrough}</Select.Trigger><Select.Content
                  >{#each ['never', 'compatible', 'always'] as value}<Select.Item
                      {value}
                      label={value}>{value}</Select.Item
                    >{/each}</Select.Content
                ></Select.Root
              ></Field.Field
            >
          </div>
        </div>
        <div class="toggles">
          <label
            ><input type="checkbox" bind:checked={toneMap} /><span
              ><strong>Tone mapping</strong><small
                >Normalize HDR sources through the selected filter path.</small
              ></span
            ></label
          ><label
            ><input type="checkbox" bind:checked={burnSubtitles} /><span
              ><strong>Burn selected subtitles</strong><small
                >Renders subtitles into video and disables video copy.</small
              ></span
            ></label
          >
        </div>
      </details>
      <footer>
        <Button variant="outline" href="/profiles">Cancel</Button><Button
          disabled={!base || !name || saving}
          onclick={() => void save()}>{saving ? 'Saving…' : 'Create immutable revision'}</Button
        >
      </footer>
    </section>
  </div></AppShell
>

<style>
  .page {
    max-width: 1080px;
    padding: 34px 38px;
  }
  .page > :global([data-slot='alert']) {
    margin-bottom: 16px;
  }
  section {
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--card);
    padding: 22px;
  }
  h2 {
    margin-bottom: 16px;
    font-size: 15px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .inline,
  .triple {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .inline span {
    color: var(--muted-foreground);
  }
  .triple :global(input) {
    min-width: 0;
  }
  details {
    margin-top: 22px;
    border-top: 1px solid var(--border);
    padding-top: 18px;
  }
  summary {
    cursor: pointer;
    color: var(--primary);
    font-size: 12px;
    font-weight: 600;
  }
  .control-group {
    margin-top: 18px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-subtle);
    padding: 17px;
  }
  .control-group h3 {
    margin-bottom: 14px;
    font-size: 12px;
  }
  .compact {
    gap: 13px;
  }
  .toggles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 12px;
  }
  .toggles label {
    display: flex;
    gap: 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 14px;
  }
  .toggles span {
    display: flex;
    flex-direction: column;
  }
  .toggles strong {
    font-size: 11px;
  }
  .toggles small {
    margin-top: 4px;
    color: var(--muted-foreground);
    font-size: 9px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 9px;
    margin-top: 22px;
    border-top: 1px solid var(--border);
    padding-top: 18px;
  }
  @media (max-width: 700px) {
    .page {
      padding: 24px 16px;
    }
    .grid,
    .toggles {
      grid-template-columns: 1fr;
    }
  }
</style>
