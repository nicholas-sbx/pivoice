<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { LL_DEFAULTS, LL_RANGES, PCM_FRAME, SEND_DELAY_MS, type LLConfig } from '../audio/ll/config'
import { call, getEngine, getNative, micLevel, setAppDevices, setOutputBuffer, updateLL } from '../call'
import { isNative, native } from '../native/bridge'
import type { AudioInfo, Glitches } from '../native/protocol'
import Segmented from './Segmented.vue'
import Slider from './Slider.vue'
import Switch from './Switch.vue'

/**
 * The latency tab: how your voice gets to everyone and theirs to you (the
 * low-latency engine, the only way there is), every knob of it. All of
 * them apply live.
 */

const c = computed(() => call.prefs.ll)
const set = <K extends keyof LLConfig>(k: K, v: LLConfig[K]) => updateLL({ [k]: v } as Partial<LLConfig>)

const redundancy: { value: 0 | 1 | 2; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 1, label: '+1 frame' },
  { value: 2, label: '+2 frames' }
]

// Your mic's level now, to set the silence threshold against.
const micDb = ref('…')
let micTimer: ReturnType<typeof setInterval> | null = null
// In the app: the sound card as it is now, and everything that could have put a click in the audio.
const appAudio = ref<AudioInfo | null>(null)
const glitches = ref<Glitches | null>(null)
let glitchTimer: ReturnType<typeof setInterval> | null = null
async function readGlitches() {
  const st = await getNative()?.stats()
  if (!st) return
  appAudio.value = st.audio
  glitches.value = st.glitches ?? null
}
onMounted(() => {
  micTimer = setInterval(() => {
    const level = micLevel()
    // micLevel() is RMS × 4, clamped; back to dBFS.
    micDb.value = level > 0 ? `${Math.round(20 * Math.log10(level / 4))} dBFS` : 'silent'
  }, 250)
  if (isNative) {
    void readGlitches()
    glitchTimer = setInterval(() => void readGlitches(), 1000)
  }
})
onBeforeUnmount(() => {
  if (micTimer) clearInterval(micTimer)
  if (glitchTimer) clearInterval(glitchTimer)
})
const onWindows = computed(() => native.app?.os === 'windows')
const glitchRows = computed(() => {
  const g = glitches.value
  if (!g) return []
  return [
    { n: g.inputOverflows, label: 'mic overruns', hint: 'the sound card’s mic buffer filled before the app read it' },
    { n: g.outputUnderflows, label: 'speaker underruns', hint: 'a block reached the speakers late' },
    { n: g.captureDropped, label: 'mic blocks dropped', hint: 'the sender fell behind' },
    { n: g.framesDropped, label: 'incoming frames dropped', hint: 'the audio thread fell behind' }
  ]
})

// What these choices cost: fixed delay, and bandwidth per listener.
const fixedMs = +SEND_DELAY_MS.toFixed(1)
const packetsPerSecond = 48_000 / PCM_FRAME
const wireKbps = computed(() => {
  // 2 bytes a sample.
  const payload = PCM_FRAME * 2
  // Our header, plus a rough 80 bytes of SCTP, DTLS, UDP and IP per packet.
  const perPacket = payload * (1 + c.value.redundancy) + 3 + 6 * (1 + c.value.redundancy) + 80
  return (perPacket * 8 * packetsPerSecond) / 1000
})

const r = LL_RANGES
// Whether the page got cross-origin isolation (and so shared memory for the engine).
const transport = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated ? 'shared' : 'messages'

// What the device actually gave us (it rounds the request to what it supports).
const buffer = computed(() => {
  void call.status
  const info = appAudio.value ?? getNative()?.info
  if (info) return `${info.block}-sample blocks (${((info.block * 1000) / 48_000).toFixed(1)} ms) · in ${info.inputLatencyMs.toFixed(1)} ms, out ${info.outputLatencyMs.toFixed(1)} ms · ${info.api}${info.mode ? ` (${info.mode})` : ''}`
  const ctx = getEngine()?.ctx
  if (!ctx) return ''
  return `${(ctx.baseLatency * 1000).toFixed(1)} ms Web Audio + ${((ctx.outputLatency || 0) * 1000).toFixed(1)} ms device`
})
</script>

<template>
  <div class="ll">
    <p class="note first">
      Everyone hears everyone as raw 16-bit PCM, one 2.7 ms block a packet, the moment it’s captured: no codec, no
      lookahead, and packets that are never retransmitted, with our own jitter buffer at the other end.
    </p>
    <div class="cost">
      Fixed delay <strong>{{ fixedMs }} ms</strong> (one block) · {{ packetsPerSecond.toFixed(0) }} packets/s · ≈
      {{ wireKbps.toFixed(0) }} kbps per listener ·
      <template v-if="isNative">straight from the sound card’s callback</template>
      <template v-else>{{ transport === 'shared' ? 'shared memory' : 'messages' }} between audio thread and worker</template>
    </div>

    <template v-if="isNative">
      <span class="eyebrow">Sound card</span>
      <p class="note">
        The app runs the microphone and the speakers in one callback, with the smallest buffer your device offers, and plays
        everyone through it: there’s no browser audio in the way.
        <template v-if="buffer"><br />Now: {{ buffer }}</template>
      </p>
      <Switch
        v-if="onWindows"
        label="Exclusive Mode"
        hint="Takes the sound card for the app alone, for WASAPI’s smallest buffers: less delay, but nothing else can play or record on it while you’re in a call. Without it, the app still asks Windows for the mic raw (no effects)."
        :model-value="call.prefs.appExclusive"
        @update:model-value="v => setAppDevices({ appExclusive: v })"
      />
      <template v-if="glitches">
        <span class="eyebrow">Glitches since the sound card opened</span>
        <ul class="glitches">
          <li v-for="g in glitchRows" :key="g.label" :class="{ bad: g.n > 0 }" :title="g.hint">
            <strong>{{ g.n }}</strong> {{ g.label }}
          </li>
          <li :class="{ bad: glitches.gcPauseMaxMs > 1 }" title="the longest the app stopped for garbage collection lately">
            <strong>{{ glitches.gcPauseMaxMs.toFixed(2) }} ms</strong> longest pause
          </li>
        </ul>
        <p class="note">
          Hear a crackle? Whatever counted up just then is why. Underruns or overruns: the sound card wants a bigger buffer, or
          something else on the machine is hogging it. Late frames in someone’s route card: the network.
        </p>
      </template>
    </template>
    <template v-else>
    <span class="eyebrow">Output</span>
    <Segmented
      label="Audio output buffer"
      :options="[
        { value: 'min', label: 'Smallest' },
        { value: 'small', label: 'Small (~5 ms)' },
        { value: 'interactive', label: 'Browser default' }
      ]"
      :model-value="call.prefs.outputBuffer"
      @update:model-value="setOutputBuffer"
    />
    <p class="note">
      Web Audio’s buffer to your speakers, which everyone plays through. Smaller is less delay and steadier timing, but
      crackles sooner on a busy machine: if people sound choppy, try a bigger one with the Raw mic test. Changing it
      reconnects you for a moment.
      <template v-if="buffer"><br />Now: {{ buffer }}</template>
    </p>
    </template>

    <span class="eyebrow">Sending</span>
    <Segmented label="Redundancy" :options="redundancy" :model-value="c.redundancy" @update:model-value="v => set('redundancy', v)" />
    <p class="note">Each packet repeats the frames before it, so one lost packet costs nothing. More bandwidth, no extra delay.</p>
    <Switch
      label="Silence Suppression"
      hint="Send nothing while you’re quiet, instead of a steady stream of silence to everyone."
      :model-value="c.dtx"
      @update:model-value="v => set('dtx', v)"
    />
    <Slider
      v-if="c.dtx"
      label="Silence threshold"
      unit=" dBFS"
      :min="r.dtxThresholdDb[0]"
      :max="r.dtxThresholdDb[1]"
      :step="r.dtxThresholdDb[2]"
      :hint="`Quieter than this counts as silence. Your mic right now: ${micDb}. Lower it if quiet words get cut; raise it if room noise keeps it sending.`"
      :model-value="c.dtxThresholdDb"
      @update:model-value="v => set('dtxThresholdDb', v)"
    />
    <Slider
      v-if="c.dtx"
      label="Silence hangover"
      unit=" ms"
      :min="r.dtxHangoverMs[0]"
      :max="r.dtxHangoverMs[1]"
      :step="r.dtxHangoverMs[2]"
      hint="Keep sending this long after you go quiet, so word endings and pauses mid-sentence aren’t cut."
      :model-value="c.dtxHangoverMs"
      @update:model-value="v => set('dtxHangoverMs', v)"
    />

    <span class="eyebrow">Receiving (jitter buffer)</span>
    <p class="note">
      It aims for the network’s jitter (the chosen percentile of how late packets have been, over the window) × multiplier +
      margin, kept between the minimum and the maximum. Choppy? Raise the percentile or the margin. Laggy? Lower them.
    </p>
    <Slider
      label="Jitter percentile"
      :min="r.jitterPercentile[0]"
      :max="r.jitterPercentile[1]"
      :step="r.jitterPercentile[2]"
      hint="How much of the lateness to cover: 99 drops about 1 packet in 100 as late; 100 covers the worst one seen."
      :model-value="c.jitterPercentile"
      @update:model-value="v => set('jitterPercentile', v)"
    />
    <Slider
      label="Jitter window"
      unit=" s"
      :min="r.jitterWindowSec[0]"
      :max="r.jitterWindowSec[1]"
      :step="r.jitterWindowSec[2]"
      hint="How far back it remembers lateness. Longer is steadier; shorter recovers faster after a bad patch."
      :model-value="c.jitterWindowSec"
      @update:model-value="v => set('jitterWindowSec', v)"
    />
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
      hint="How much playback may speed up or slow down to steer to the target (the pitch moves with it). It does that in the pauses between words, and while someone talks only if a gap is coming. 0 = only resync between sentences."
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

    <button type="button" class="reset" @click="updateLL({ ...LL_DEFAULTS })">Reset to defaults</button>
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
.note.first {
  margin-top: 0;
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
.glitches {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0 0 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-tertiary);
  list-style: none;
  font-size: 13px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.glitches strong {
  color: var(--header-primary);
}
.glitches .bad strong {
  color: var(--red);
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
