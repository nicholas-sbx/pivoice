<script setup lang="ts">
import { computed } from 'vue'
import { LL_DEFAULTS, LL_RANGES, lookaheadMs, type FrameMs, type LLConfig, type OpusApplication } from '../audio/ll/config'
import { call, llSupported, updateLL, updatePrefs } from '../call'
import Segmented from './Segmented.vue'
import Slider from './Slider.vue'
import Switch from './Switch.vue'

/** Every knob of the experimental low-latency engine. All of them apply live. */

const c = computed(() => call.prefs.ll)
const set = <K extends keyof LLConfig>(k: K, v: LLConfig[K]) => updateLL({ [k]: v } as Partial<LLConfig>)

const frames: { value: FrameMs; label: string }[] = [
  { value: 2.5, label: '2.5 ms' },
  { value: 5, label: '5 ms' },
  { value: 10, label: '10 ms' },
  { value: 20, label: '20 ms' }
]
const apps: { value: OpusApplication; label: string }[] = [
  { value: 'lowdelay', label: 'Low delay' },
  { value: 'voip', label: 'VoIP' },
  { value: 'audio', label: 'Audio' }
]
const appHints: Record<OpusApplication, string> = {
  lowdelay: 'CELT only: 2.5 ms lookahead. Lowest delay.',
  voip: 'Tuned for speech: 6.5 ms lookahead. Below 10 ms frames it’s CELT anyway.',
  audio: 'Tuned for music: 6.5 ms lookahead.'
}
const redundancy: { value: 0 | 1 | 2; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 1, label: '+1 frame' },
  { value: 2, label: '+2 frames' }
]

// What these choices cost: fixed delay, and bandwidth per listener.
const fixedMs = computed(() => c.value.frameMs + lookaheadMs(c.value.application))
const packetsPerSecond = computed(() => 1000 / c.value.frameMs)
const wireKbps = computed(() => {
  const payload = (c.value.bitrateKbps * 1000 * c.value.frameMs) / 1000 / 8
  // Our header, plus a rough 80 bytes of SCTP, DTLS, UDP and IP per packet.
  const perPacket = payload * (1 + c.value.redundancy) + 3 + 6 * (1 + c.value.redundancy) + 80
  return (perPacket * 8 * packetsPerSecond.value) / 1000
})

const r = LL_RANGES
</script>

<template>
  <div class="ll">
    <Switch
      label="Low-Latency Engine (Experimental)"
      :hint="
        llSupported
          ? 'Replaces WebRTC’s audio with people who have it on too: the browser’s Opus at frame sizes WebRTC won’t do, our own jitter buffer, and packets that are never retransmitted. Changes apply live.'
          : 'This browser doesn’t have WebCodecs audio, which the engine needs.'
      "
      :model-value="c.enabled && llSupported"
      @update:model-value="v => set('enabled', v)"
    />

    <div class="cost">
      Fixed delay <strong>{{ fixedMs }} ms</strong> (frame + lookahead) · {{ packetsPerSecond.toFixed(0) }} packets/s · ≈
      {{ wireKbps.toFixed(0) }} kbps per listener
    </div>

    <span class="eyebrow">Both engines</span>
    <Segmented
      label="Audio output buffer"
      :options="[
        { value: 'min', label: 'Smallest (2.7 ms)' },
        { value: 'interactive', label: 'Browser default (~10 ms)' }
      ]"
      :model-value="call.prefs.outputBuffer"
      @update:model-value="v => updatePrefs({ outputBuffer: v })"
    />
    <p class="note">
      Web Audio’s buffer to your speakers. Smallest is far less delay and much steadier timing for this engine; pick the default
      if you hear crackling. Takes effect when you next join.
    </p>

    <span class="eyebrow">Sending</span>
    <Segmented label="Frame size" :options="frames" :model-value="c.frameMs" @update:model-value="v => set('frameMs', v)" />
    <Segmented label="Opus mode" :options="apps" :model-value="c.application" @update:model-value="v => set('application', v)" />
    <p class="note">{{ appHints[c.application] }}</p>
    <Slider label="Bitrate" unit=" kbps" :min="r.bitrateKbps[0]" :max="r.bitrateKbps[1]" :step="r.bitrateKbps[2]" :model-value="c.bitrateKbps" @update:model-value="v => set('bitrateKbps', v)" />
    <Slider
      label="Encoder complexity"
      :min="r.complexity[0]"
      :max="r.complexity[1]"
      :step="r.complexity[2]"
      hint="CPU against quality. No effect on delay."
      :model-value="c.complexity"
      @update:model-value="v => set('complexity', v)"
    />
    <Segmented label="Redundancy" :options="redundancy" :model-value="c.redundancy" @update:model-value="v => set('redundancy', v)" />
    <p class="note">Each packet repeats the frames before it, so one lost packet costs nothing. More bandwidth, no extra delay.</p>
    <Switch label="Silence Suppression (DTX)" hint="Send nothing while you’re quiet." :model-value="c.dtx" @update:model-value="v => set('dtx', v)" />
    <Slider
      v-if="c.dtx"
      label="Silence threshold"
      unit=" dBFS"
      :min="r.dtxThresholdDb[0]"
      :max="r.dtxThresholdDb[1]"
      :step="r.dtxThresholdDb[2]"
      hint="Quieter than this counts as silence. Raise it if your room noise keeps it sending; lower it if quiet words get cut."
      :model-value="c.dtxThresholdDb"
      @update:model-value="v => set('dtxThresholdDb', v)"
    />

    <span class="eyebrow">Receiving (jitter buffer)</span>
    <p class="note">
      It aims for the network’s jitter (95th percentile over 2 s) × multiplier + margin, kept between the minimum and the
      maximum.
    </p>
    <Slider label="Jitter multiplier" unit="×" :digits="1" :min="r.jitterMultiplier[0]" :max="r.jitterMultiplier[1]" :step="r.jitterMultiplier[2]" :model-value="c.jitterMultiplier" @update:model-value="v => set('jitterMultiplier', v)" />
    <Slider label="Safety margin" unit=" ms" :min="r.marginMs[0]" :max="r.marginMs[1]" :step="r.marginMs[2]" :model-value="c.marginMs" @update:model-value="v => set('marginMs', v)" />
    <Slider label="Minimum buffer" unit=" ms" :min="r.minBufferMs[0]" :max="r.minBufferMs[1]" :step="r.minBufferMs[2]" :model-value="c.minBufferMs" @update:model-value="v => set('minBufferMs', v)" />
    <Slider label="Maximum buffer" unit=" ms" :min="r.maxBufferMs[0]" :max="r.maxBufferMs[1]" :step="r.maxBufferMs[2]" :model-value="c.maxBufferMs" @update:model-value="v => set('maxBufferMs', v)" />
    <Slider
      label="Speed adjustment"
      unit="%"
      :digits="1"
      :min="r.stretchPct[0]"
      :max="r.stretchPct[1]"
      :step="r.stretchPct[2]"
      hint="How much playback may speed up or slow down to steer to the target. 0 = only resync between sentences."
      :model-value="c.stretchPct"
      @update:model-value="v => set('stretchPct', v)"
    />
    <Slider
      label="Concealment"
      unit=" ms"
      :min="r.concealMs[0]"
      :max="r.concealMs[1]"
      :step="r.concealMs[2]"
      hint="How long a gap is covered by fading out the last frame before it goes silent."
      :model-value="c.concealMs"
      @update:model-value="v => set('concealMs', v)"
    />

    <button type="button" class="reset" @click="updateLL({ ...LL_DEFAULTS, enabled: c.enabled })">Reset to defaults</button>
  </div>
</template>

<style scoped>
.eyebrow {
  display: block;
  margin: 16px 0 4px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--header-secondary);
}
.note {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.cost {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-tertiary);
  font-size: 13px;
  color: var(--text-normal);
}
.cost strong {
  color: var(--header-primary);
}
.reset {
  margin-top: 12px;
  border: 0;
  background: none;
  padding: 0;
  color: var(--text-link);
  font-size: 14px;
  cursor: pointer;
}
.reset:hover {
  text-decoration: underline;
}
</style>
