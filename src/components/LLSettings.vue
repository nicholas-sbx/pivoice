<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { LL_DEFAULTS, LL_RANGES, type FrameMs, type LLConfig, type OpusApplication, captureFrame, sendDelayMs, type LLCodec } from '../audio/ll/config'
import { call, getEngine, getNative, llSupported, micLevel, setAppDevices, setOutputBuffer, updateLL } from '../call'
import { t } from '../i18n'
import { isNative, native } from '../native/bridge'
import type { AudioInfo, Glitches } from '../native/protocol'
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
const apps = computed<{ value: OpusApplication; label: string }[]>(() => [
  { value: 'lowdelay', label: t('ll.appLowdelay') },
  { value: 'voip', label: t('ll.appVoip') },
  { value: 'audio', label: t('ll.appAudio') }
])
const appHint = computed(() => t(({ lowdelay: 'll.appLowdelayHint', voip: 'll.appVoipHint', audio: 'll.appAudioHint' } as const)[c.value.application]))
const codecs = computed<{ value: LLCodec; label: string }[]>(() => [
  { value: 'opus', label: t('ll.codecOpus') },
  { value: 'pcm', label: t('ll.codecPCM') }
])
const redundancy = computed<{ value: 0 | 1 | 2; label: string }[]>(() => [
  { value: 0, label: t('common.off') },
  { value: 1, label: t('ll.redundancy1') },
  { value: 2, label: t('ll.redundancy2') }
])
const bufferOptions = computed(() => [
  { value: 'min' as const, label: t('ll.bufferMin') },
  { value: 'small' as const, label: t('ll.bufferSmall') },
  { value: 'interactive' as const, label: t('ll.bufferDefault') }
])

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
    micDb.value = level > 0 ? `${Math.round(20 * Math.log10(level / 4))} dBFS` : t('ll.micSilent')
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
    { n: g.inputOverflows, label: t('ll.glitch.inputOverflows'), hint: t('ll.glitch.inputOverflowsHint') },
    { n: g.outputUnderflows, label: t('ll.glitch.outputUnderflows'), hint: t('ll.glitch.outputUnderflowsHint') },
    { n: g.captureDropped, label: t('ll.glitch.captureDropped'), hint: t('ll.glitch.captureDroppedHint') },
    { n: g.framesDropped, label: t('ll.glitch.framesDropped'), hint: t('ll.glitch.framesDroppedHint') }
  ]
})

// What these choices cost: fixed delay, and bandwidth per listener.
const fixedMs = computed(() => +sendDelayMs(c.value).toFixed(1))
const frameMsNow = computed(() => (captureFrame(c.value) * 1000) / 48_000)
const packetsPerSecond = computed(() => 1000 / frameMsNow.value)
const wireKbps = computed(() => {
  // PCM: 2 bytes a sample. Opus: whatever the bitrate gives for one frame.
  const payload =
    c.value.codec === 'pcm' ? captureFrame(c.value) * 2 : (c.value.bitrateKbps * 1000 * c.value.frameMs) / 1000 / 8
  // Our header, plus a rough 80 bytes of SCTP, DTLS, UDP and IP per packet.
  const perPacket = payload * (1 + c.value.redundancy) + 3 + 6 * (1 + c.value.redundancy) + 80
  return (perPacket * 8 * packetsPerSecond.value) / 1000
})

const r = LL_RANGES
// Whether the page got cross-origin isolation (and so shared memory for the engine).
const transport = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated ? 'shared' : 'messages'

// What the device actually gave us (it rounds the request to what it supports).
const buffer = computed(() => {
  void call.status
  const info = appAudio.value ?? getNative()?.info
  if (info) {
    return t(info.mode ? 'll.bufferNowMode' : 'll.bufferNow', {
      block: info.block,
      blockMs: ((info.block * 1000) / 48_000).toFixed(1),
      input: info.inputLatencyMs.toFixed(1),
      output: info.outputLatencyMs.toFixed(1),
      api: info.api,
      mode: info.mode ?? ''
    })
  }
  const ctx = getEngine()?.ctx
  if (!ctx) return ''
  return t('ll.bufferWebAudio', { base: (ctx.baseLatency * 1000).toFixed(1), device: ((ctx.outputLatency || 0) * 1000).toFixed(1) })
})
</script>

<template>
  <div class="ll">
    <Switch
:label="t('ll.engine')"
      :hint="t(llSupported ? 'll.engineHint' : 'll.engineUnsupported')"
      :model-value="c.enabled && llSupported"
      @update:model-value="v => set('enabled', v)"
    />

    <div class="cost">
      {{ t('ll.fixedDelay') }} <strong>{{ fixedMs }} ms</strong>
      {{
        t('ll.costRest', {
          what: t(c.codec === 'pcm' ? 'll.costOneBlock' : 'll.costFrame'),
          packets: packetsPerSecond.toFixed(0),
          kbps: wireKbps.toFixed(0),
          transport: isNative ? t('ll.transportApp') : t(transport === 'shared' ? 'll.transportShared' : 'll.transportMessages')
        })
      }}
    </div>

    <template v-if="isNative">
      <span class="eyebrow">{{ t('ll.soundCard') }}</span>
      <p class="note">
        {{ t('ll.soundCardNote') }}
        <template v-if="buffer"><br />{{ t('ll.now', { buffer }) }}</template>
      </p>
      <Switch
        v-if="onWindows"
:label="t('ll.exclusive')"
        :hint="t('ll.exclusiveHint')"
        :model-value="call.prefs.appExclusive"
        @update:model-value="v => setAppDevices({ appExclusive: v })"
      />
      <template v-if="glitches">
        <span class="eyebrow">{{ t('ll.glitches') }}</span>
        <ul class="glitches">
          <li v-for="g in glitchRows" :key="g.label" :class="{ bad: g.n > 0 }" :title="g.hint">
            <strong>{{ g.n }}</strong> {{ g.label }}
          </li>
          <li :class="{ bad: glitches.gcPauseMaxMs > 1 }" :title="t('ll.glitch.gcPauseHint')">
            <strong>{{ glitches.gcPauseMaxMs.toFixed(2) }} ms</strong> {{ t('ll.glitch.gcPause') }}
          </li>
        </ul>
        <p class="note">
          {{ t('ll.glitchesNote') }}
        </p>
      </template>
    </template>
    <template v-else>
    <span class="eyebrow">{{ t('ll.bothEngines') }}</span>
    <Segmented
      :label="t('ll.outputBuffer')"
      :options="bufferOptions"
      :model-value="call.prefs.outputBuffer"
      @update:model-value="setOutputBuffer"
    />
    <p class="note">
      {{ t('ll.outputBufferNote') }}
      <template v-if="buffer"><br />{{ t('ll.now', { buffer }) }}</template>
    </p>
    </template>

    <span class="eyebrow">{{ t('ll.sending') }}</span>
    <Segmented :label="t('ll.codec')" :options="codecs" :model-value="c.codec" @update:model-value="v => set('codec', v)" />
    <p class="note">
      {{ t(c.codec === 'pcm' ? 'll.codecPCMNote' : 'll.codecOpusNote') }}
    </p>
    <template v-if="c.codec === 'opus'">
    <Segmented :label="t('ll.frameSize')" :options="frames" :model-value="c.frameMs" @update:model-value="v => set('frameMs', v)" />
    <Segmented :label="t('ll.opusMode')" :options="apps" :model-value="c.application" @update:model-value="v => set('application', v)" />
    <p class="note">{{ appHint }}</p>
    <Slider :label="t('ll.bitrate')" unit=" kbps" :min="r.bitrateKbps[0]" :max="r.bitrateKbps[1]" :step="r.bitrateKbps[2]" :model-value="c.bitrateKbps" @update:model-value="v => set('bitrateKbps', v)" />
    <Slider
      :label="t('ll.complexity')"
      :min="r.complexity[0]"
      :max="r.complexity[1]"
      :step="r.complexity[2]"
      :hint="t('ll.complexityHint')"
      :model-value="c.complexity"
      @update:model-value="v => set('complexity', v)"
    />
    </template>
    <Segmented :label="t('ll.redundancy')" :options="redundancy" :model-value="c.redundancy" @update:model-value="v => set('redundancy', v)" />
    <p class="note">{{ t('ll.redundancyNote') }}</p>
    <Switch :label="t('settings.dtx')" :hint="t('ll.dtxHint')" :model-value="c.dtx" @update:model-value="v => set('dtx', v)" />
    <Slider
      v-if="c.dtx"
      :label="t('ll.silenceThreshold')"
      unit=" dBFS"
      :min="r.dtxThresholdDb[0]"
      :max="r.dtxThresholdDb[1]"
      :step="r.dtxThresholdDb[2]"
      :hint="t('ll.silenceThresholdHint', { level: micDb })"
      :model-value="c.dtxThresholdDb"
      @update:model-value="v => set('dtxThresholdDb', v)"
    />
    <Slider
      v-if="c.dtx"
      :label="t('ll.silenceHangover')"
      unit=" ms"
      :min="r.dtxHangoverMs[0]"
      :max="r.dtxHangoverMs[1]"
      :step="r.dtxHangoverMs[2]"
      :hint="t('ll.silenceHangoverHint')"
      :model-value="c.dtxHangoverMs"
      @update:model-value="v => set('dtxHangoverMs', v)"
    />

    <span class="eyebrow">{{ t('ll.receiving') }}</span>
    <p class="note">
      {{ t('ll.receivingNote') }}
    </p>
    <Slider
      :label="t('ll.jitterPercentile')"
      :min="r.jitterPercentile[0]"
      :max="r.jitterPercentile[1]"
      :step="r.jitterPercentile[2]"
      :hint="t('ll.jitterPercentileHint')"
      :model-value="c.jitterPercentile"
      @update:model-value="v => set('jitterPercentile', v)"
    />
    <Slider
      :label="t('ll.jitterWindow')"
      unit=" s"
      :min="r.jitterWindowSec[0]"
      :max="r.jitterWindowSec[1]"
      :step="r.jitterWindowSec[2]"
      :hint="t('ll.jitterWindowHint')"
      :model-value="c.jitterWindowSec"
      @update:model-value="v => set('jitterWindowSec', v)"
    />
    <Slider :label="t('ll.jitterMultiplier')" unit="×" :digits="1" :min="r.jitterMultiplier[0]" :max="r.jitterMultiplier[1]" :step="r.jitterMultiplier[2]" :model-value="c.jitterMultiplier" @update:model-value="v => set('jitterMultiplier', v)" />
    <Slider :label="t('ll.margin')" unit=" ms" :min="r.marginMs[0]" :max="r.marginMs[1]" :step="r.marginMs[2]" :model-value="c.marginMs" @update:model-value="v => set('marginMs', v)" />
    <Slider :label="t('ll.minBuffer')" unit=" ms" :min="r.minBufferMs[0]" :max="r.minBufferMs[1]" :step="r.minBufferMs[2]" :model-value="c.minBufferMs" @update:model-value="v => set('minBufferMs', v)" />
    <Slider :label="t('ll.maxBuffer')" unit=" ms" :min="r.maxBufferMs[0]" :max="r.maxBufferMs[1]" :step="r.maxBufferMs[2]" :model-value="c.maxBufferMs" @update:model-value="v => set('maxBufferMs', v)" />
    <Slider
      :label="t('ll.stretch')"
      unit="%"
      :digits="1"
      :min="r.stretchPct[0]"
      :max="r.stretchPct[1]"
      :step="r.stretchPct[2]"
      :hint="t('ll.stretchHint')"
      :model-value="c.stretchPct"
      @update:model-value="v => set('stretchPct', v)"
    />
    <Slider
      :label="t('ll.conceal')"
      unit=" ms"
      :min="r.concealMs[0]"
      :max="r.concealMs[1]"
      :step="r.concealMs[2]"
      :hint="t('ll.concealHint')"
      :model-value="c.concealMs"
      @update:model-value="v => set('concealMs', v)"
    />

    <button type="button" class="reset" @click="updateLL({ ...LL_DEFAULTS, enabled: c.enabled })">{{ t('common.resetToDefaults') }}</button>
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
