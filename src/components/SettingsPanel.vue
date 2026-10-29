<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { AudioEngine, type SpatialMode } from '../audio/engine'
import { applyMicPrefs, call, getEngine, getNative, llSupported, micLevel, setAppDevices, setDtx, setOutput, setSpatial, startMicTest, stopMicTest, type TestPath } from '../call'
import { isNative, native } from '../native/bridge'
import Segmented from './Segmented.vue'
import Icon from './Icon.vue'
import LLSettings from './LLSettings.vue'
import OverlaySettings from './OverlaySettings.vue'
import { overlaySupported } from '../native/overlay'
import Slider from './Slider.vue'
import Switch from './Switch.vue'
import { vSnap } from '../lib/snap'

/** Voice settings, popping up over the call controls. */

const emit = defineEmits<{ close: [] }>()

const el = ref<HTMLElement>()
const tab = ref<'voice' | 'll' | 'overlay'>('voice')
const inputs = ref<MediaDeviceInfo[]>([])
const outputs = ref<MediaDeviceInfo[]>([])
const level = ref(0)
const canPickOutput = isNative || AudioEngine.canPickOutput()
let raf = 0

async function loadDevices() {
  const app = getNative()
  if (app) {
    // The app's own devices, the sound card's names for them.
    const all = await app.devices()
    const info = (d: (typeof all)[number], kind: MediaDeviceKind) => ({ deviceId: d.id, label: d.name + (d.default ? ' (default)' : ''), kind }) as MediaDeviceInfo
    // "default" follows whatever the system's default is, as the browser's does.
    const def = (kind: MediaDeviceKind) => ({ deviceId: 'default', label: 'System default', kind }) as MediaDeviceInfo
    inputs.value = [def('audioinput'), ...all.filter(d => d.input).map(d => info(d, 'audioinput'))]
    outputs.value = [def('audiooutput'), ...all.filter(d => d.output).map(d => info(d, 'audiooutput'))]
    return
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    inputs.value = all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications')
    outputs.value = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications')
  } catch {
    inputs.value = []
    outputs.value = []
  }
}

const currentInput = computed(() => (isNative ? call.prefs.appInputId : call.prefs.inputId || getEngine()?.micDeviceId) || 'default')
const currentOutput = computed(() => (isNative ? call.prefs.appOutputId : call.prefs.outputId) || 'default')

function pickInput(id: string) {
  if (isNative) setAppDevices({ appInputId: id === 'default' ? '' : id })
  else void applyMicPrefs({ inputId: id })
}
function pickOutput(id: string) {
  if (isNative) setAppDevices({ appOutputId: id === 'default' ? '' : id })
  else void setOutput(id)
}

function label(d: MediaDeviceInfo, i: number, kind: string) {
  return d.label || `${kind} ${i + 1}`
}

const modes: { value: SpatialMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Straight to your ears. Lowest latency.' },
  { value: 'stereo', label: 'Stereo', hint: 'Louder on the side they sit: panned by level only.' },
  isNative
    ? {
        value: 'hrtf',
        label: 'Binaural',
        hint: 'A modelled head between your ears: the ear away from someone hears them up to 0.66 ms later and duller, the near one a little brighter, so voices sound placed around the table rather than just louder on one side. Only the far ear waits; the person across from you sounds just as with it off. On headphones.'
      }
    : { value: 'hrtf', label: 'HRTF', hint: 'Full 3D around your head, on headphones.' }
]
const modeHint = computed(() => modes.find(m => m.value === call.prefs.spatial)?.hint)

const testPaths = computed<{ value: TestPath; label: string }[]>(() => [
  { value: 'raw', label: 'Raw' },
  // The app has no WebRTC audio stack of its own to test.
  ...(isNative ? [] : [{ value: 'webrtc' as const, label: 'WebRTC audio' }]),
  ...(llSupported ? [{ value: 'll' as const, label: 'Low latency' }] : [])
])
function pickPath(v: TestPath) {
  if (call.test.on) void startMicTest(v)
  else call.test.path = v
}
const testHints: Record<TestPath, string> = {
  raw: isNative
    ? 'Mic straight to your ears inside the sound card’s own callback, like pw-loopback. The floor every path sits on.'
    : 'Mic straight to your ears: your devices and the browser’s buffers. The floor every path sits on.',
  webrtc: 'Through WebRTC’s encoder, jitter buffer and playout, exactly as a call, minus the network.',
  ll: 'Through the low-latency engine: its silence gate, encoder, packets, decoder and jitter buffer, minus the network.'
}

const processing = [
  { key: 'echoCancellation', label: 'Echo Cancellation' },
  { key: 'noiseSuppression', label: 'Noise Suppression' },
  { key: 'autoGainControl', label: 'Automatic Gain Control' }
] as const

// The app does its own processing, each with what it costs in delay.
const appProcessing = computed(() => [
  {
    key: 'echoCancellation' as const,
    label: 'Echo Cancellation',
    hint: 'Takes what your speakers play back out of your mic (SpeexDSP). Adds at most one 2.7 ms block, none at all on most sound cards. Only if you’re not on headphones.',
    off: false
  },
  {
    key: 'noiseSuppression' as const,
    label: 'Noise Suppression',
    hint:
      native.app?.noise === false
        ? 'Not in this build of the app.'
        : `RNNoise: a small neural network takes out fans, keyboards and hum. Adds 10 ms (its analysis window) plus up to 10 ms to fill a frame${call.prefs.noiseLookahead ? ', plus 10 ms of lookahead' : ''}.`,
    off: native.app?.noise === false
  },
  {
    key: 'autoGainControl' as const,
    label: 'Automatic Gain Control',
    hint: 'Brings your voice to a steady level by changing the app’s own gain (never your system’s mic volume): down for a loud mic, up for a quiet one. Adds no delay.',
    off: false
  }
])
const gatePct = computed(() => Math.round(call.prefs.noiseGate * 100))

function meter() {
  level.value = micLevel()
  raf = requestAnimationFrame(meter)
}

function onDown(e: PointerEvent) {
  const t = e.target as HTMLElement
  if (el.value && !el.value.contains(t) && !t.closest('[data-settings-toggle]')) emit('close')
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  void loadDevices()
  navigator.mediaDevices?.addEventListener('devicechange', loadDevices)
  addEventListener('pointerdown', onDown, true)
  addEventListener('keydown', onKey)
  raf = requestAnimationFrame(meter)
})
onBeforeUnmount(() => {
  navigator.mediaDevices?.removeEventListener('devicechange', loadDevices)
  removeEventListener('pointerdown', onDown, true)
  removeEventListener('keydown', onKey)
  cancelAnimationFrame(raf)
  stopMicTest()
})
</script>

<template>
  <div ref="el" v-snap class="panel" role="dialog" aria-label="Voice settings">
    <header>
      <h2>Voice Settings</h2>
      <button type="button" class="x" aria-label="Close" @click="emit('close')"><Icon name="close" :size="20" /></button>
    </header>
    <nav class="tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'voice'" :class="{ active: tab === 'voice' }" @click="tab = 'voice'">Voice</button>
      <button type="button" role="tab" :aria-selected="tab === 'll'" :class="{ active: tab === 'll' }" @click="tab = 'll'">
        Low Latency <span class="badge">Beta</span>
      </button>
      <button
        v-if="overlaySupported"
        type="button"
        role="tab"
        :aria-selected="tab === 'overlay'"
        :class="{ active: tab === 'overlay' }"
        @click="tab = 'overlay'"
      >
        Overlay
      </button>
    </nav>
    <LLSettings v-if="tab === 'll'" />
    <OverlaySettings v-else-if="tab === 'overlay'" />
    <template v-else>

    <div class="row two">
      <label class="field">
        <span class="eyebrow">Input Device</span>
        <select :value="currentInput" @change="pickInput(($event.target as HTMLSelectElement).value)">
          <option v-for="(d, i) in inputs" :key="d.deviceId" :value="d.deviceId">{{ label(d, i, 'Microphone') }}</option>
          <option v-if="!inputs.length" value="default">Default</option>
        </select>
      </label>
      <label v-if="canPickOutput" class="field">
        <span class="eyebrow">Output Device</span>
        <select :value="currentOutput" @change="pickOutput(($event.target as HTMLSelectElement).value)">
          <option v-for="(d, i) in outputs" :key="d.deviceId" :value="d.deviceId">{{ label(d, i, 'Speaker') }}</option>
          <option v-if="!outputs.length" value="default">Default</option>
        </select>
      </label>
    </div>

    <div class="row">
      <span class="eyebrow">Input Level</span>
      <div class="meter" :class="{ dead: !!call.micProblem }">
        <div class="fill" :style="{ transform: `scaleX(${level})` }" />
      </div>

    <div class="row">
      <span class="eyebrow">Mic Test</span>
      <p class="note first">
        Hear yourself through one path, with no network in the way, and see how long it takes. You're deafened while it runs.
      </p>
      <Segmented
        :options="testPaths"
        :model-value="call.test.path"
        @update:model-value="pickPath"
      />
      <div class="test-row">
        <button type="button" class="test-btn" :class="{ stop: call.test.on }" @click="call.test.on ? stopMicTest() : startMicTest(call.test.path)">
          {{ call.test.on ? 'Stop Testing' : "Let's Check" }}
        </button>
        <div v-if="call.test.on" class="test-out" aria-live="polite">
          <strong>{{ call.test.ms === null ? '…' : `${call.test.measured ? '' : '≈ '}${Math.round(call.test.ms)} ms` }}</strong>
          <span>{{ call.test.measured ? 'mic to ears, measured' : 'mic to ears' }}</span>
          <small v-if="call.test.detail">{{ call.test.detail }}</small>
        </div>
      </div>
      <p class="note">{{ testHints[call.test.path] }}</p>
    </div>
      <p v-if="call.micProblem" class="note bad">
        {{ call.micProblem === 'denied' ? 'Microphone access is blocked for this site.' : 'No microphone found.' }}
      </p>
    </div>

    <div class="row">
      <span class="eyebrow">Spatial Audio</span>
      <div class="seg" role="radiogroup">
        <button
          v-for="m in modes"
          :key="m.value"
          type="button"
          role="radio"
          :aria-checked="call.prefs.spatial === m.value"
          :class="{ active: call.prefs.spatial === m.value }"
          @click="setSpatial(m.value)"
        >
          {{ m.label }}
        </button>
      </div>
      <p class="note">{{ modeHint }}</p>
    </div>

    <div class="row">
      <span class="eyebrow">Voice Processing</span>
      <template v-if="isNative">
        <Switch
          v-for="p in appProcessing"
          :key="p.key"
          :label="p.label"
          :hint="p.hint"
          :disabled="p.off"
          :model-value="call.prefs[p.key] && !p.off"
          @update:model-value="v => applyMicPrefs({ [p.key]: v })"
        />
        <template v-if="call.prefs.noiseSuppression && native.app?.noise !== false">
          <Switch
            label="Lookahead"
            hint="RNNoise as its authors run it: it hears the next 10 ms before deciding, so the first sound of each word comes through cleaner. Costs those 10 ms. Off, nothing is held back."
            :model-value="call.prefs.noiseLookahead"
            @update:model-value="v => setAppDevices({ noiseLookahead: v })"
          />
          <Slider
            label="Voice gate"
            unit="%"
            :min="0"
            :max="95"
            :step="5"
            :hint="
              gatePct === 0
                ? 'Off: noise is taken out, but you’re never faded to silence.'
                : `Fades you out when RNNoise is less than ${gatePct}% sure you’re talking. Lower keeps more of quiet words; higher cuts more noise between them.`
            "
            :model-value="gatePct"
            @update:model-value="v => setAppDevices({ noiseGate: v / 100 })"
          />
          <Slider
            v-if="gatePct > 0"
            label="Gate hold"
            unit=" ms"
            :min="100"
            :max="1000"
            :step="50"
            hint="How long the gate stays open after you stop, so word endings and pauses mid-sentence aren’t cut. It opens again the moment you speak; nothing is held back to look ahead."
            :model-value="call.prefs.noiseGraceMs"
            @update:model-value="v => setAppDevices({ noiseGraceMs: v })"
          />
        </template>
        <template v-if="call.prefs.autoGainControl">
          <Slider
            label="Target level"
            unit=" dBFS"
            :min="-30"
            :max="-6"
            :step="1"
            hint="How loud it brings you to (the average of your speech, not its peaks). Higher is louder; the loudest settings lean on the limiter for shouts."
            :model-value="call.prefs.agcTargetDb"
            @update:model-value="v => setAppDevices({ agcTargetDb: v })"
          />
          <Slider
            label="Max boost"
            unit=" dB"
            :min="0"
            :max="40"
            :step="1"
            hint="The most it will turn a quiet mic up. More reaches quieter mics, and lifts their background noise with them."
            :model-value="call.prefs.agcMaxDb"
            @update:model-value="v => setAppDevices({ agcMaxDb: v })"
          />
        </template>
        <p class="note spaced">All off, the app doesn’t touch your mic at all, and none of it costs anything.</p>
      </template>
      <template v-else>
      <Switch
        v-for="p in processing"
        :key="p.key"
        :label="p.label"
        :model-value="call.prefs[p.key]"
        @update:model-value="v => applyMicPrefs({ [p.key]: v })"
      />
      <p class="note">Off for the lowest latency. Turn them on if you're not on headphones.</p>
      </template>
      <Switch
        label="Silence Suppression (DTX)"
        hint="People stop sending you audio while they're quiet. Saves bandwidth, adds ~9 ms of buffering. Changing it reconnects you for a moment."
        :model-value="call.prefs.dtx"
        @update:model-value="setDtx"
      />
    </div>
    </template>
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  max-height: calc(100vh - 170px);
  overflow-y: auto;
  bottom: calc(100% + 14px);
  left: 50%;
  margin-left: -220px;
  width: 440px;
  padding: 16px;
  border-radius: 8px;
  background: var(--bg-primary);
  box-shadow: var(--elevation-high), var(--elevation-stroke);
  text-align: left;
  cursor: default;
}
/* Small screens: a sheet across the screen, above the call controls. */
@media (max-width: 640px), (pointer: coarse) and (max-height: 520px) {
  .panel {
    position: fixed;
    left: calc(8px + env(safe-area-inset-left));
    right: calc(8px + env(safe-area-inset-right));
    bottom: calc(100px + env(safe-area-inset-bottom));
    width: auto;
    margin-left: 0;
    max-height: calc(100dvh - 100px - 64px - env(safe-area-inset-bottom) - env(safe-area-inset-top));
    padding: 14px;
    overscroll-behavior: contain;
  }
  /* 16px or more, or iOS zooms the page in when one's opened. */
  select {
    font-size: 16px;
  }
}
.tabs {
  display: flex;
  gap: 16px;
  margin: -4px 0 12px;
  border-bottom: 1px solid var(--bg-modifier-hover);
}
.tabs button {
  padding: 6px 0 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--interactive-normal);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
}
.tabs button:hover {
  color: var(--interactive-hover);
}
.tabs button.active {
  color: var(--header-primary);
  border-bottom-color: var(--brand);
}
.badge {
  margin-left: 4px;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--brand);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  vertical-align: 2px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--header-primary);
}
.x {
  border: 0;
  background: none;
  color: var(--interactive-normal);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}
.x:hover {
  color: var(--interactive-hover);
}
.row {
  margin-top: 16px;
}
.row.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 0;
}
.field {
  display: block;
  min-width: 0;
}
.eyebrow {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--header-secondary);
}
select {
  width: 100%;
  height: 40px;
  padding: 0 10px;
  border: 1px solid var(--bg-tertiary);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-normal);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  text-overflow: ellipsis;
}
.meter {
  height: 8px;
  border-radius: 4px;
  background: var(--bg-accent);
  overflow: hidden;
}
.meter .fill {
  height: 100%;
  background: var(--green);
  transform-origin: left center;
  transition: transform 0.05s linear;
}
.meter.dead {
  opacity: 0.4;
}
.seg {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 3px;
  gap: 3px;
  border-radius: 6px;
  background: var(--bg-tertiary);
}
.seg button {
  height: 32px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--interactive-normal);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}
.seg button:hover {
  background: var(--bg-modifier-hover);
  color: var(--interactive-hover);
}
.seg button.active {
  background: var(--brand);
  color: #fff;
}
.note.first {
  margin: 0 0 8px;
}
.test-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.test-btn {
  flex: none;
  min-width: 112px;
  height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 3px;
  background: var(--brand);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}
.test-btn:hover {
  background: var(--brand-hover);
}
.test-btn.stop {
  background: var(--red-strong);
}
.test-btn.stop:hover {
  background: var(--red-hover);
}
.test-out {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  font-size: 13px;
  color: var(--text-muted);
}
.test-out strong {
  font-size: 18px;
  color: var(--header-primary);
  font-variant-numeric: tabular-nums;
}
.test-out small {
  flex-basis: 100%;
  font-size: 12px;
}
.note {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}
.note.bad {
  color: var(--red);
}
.note.spaced {
  margin: 4px 0 12px;
}
</style>
