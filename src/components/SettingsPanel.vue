<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { AudioEngine, type SpatialMode } from '../audio/engine'
import { applyMicPrefs, call, getEngine, getNative, llSupported, micLevel, setAppDevices, setDtx, setOutput, setSpatial, startMicTest, stopMicTest, type TestPath } from '../call'
import { t } from '../i18n'
import { DEFAULT_PREFS } from '../lib/prefs'
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
    const def = (kind: MediaDeviceKind) => ({ deviceId: 'default', label: t('common.systemDefault'), kind }) as MediaDeviceInfo
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

const modes = computed<{ value: SpatialMode; label: string; hint: string }[]>(() => [
  { value: 'off', label: t('common.off'), hint: t('spatial.offHint') },
  { value: 'stereo', label: t('spatial.stereo'), hint: t('spatial.stereoHint') },
  isNative
    ? { value: 'hrtf', label: t('spatial.binaural'), hint: t('spatial.binauralHint') }
    : { value: 'hrtf', label: t('spatial.hrtf'), hint: t('spatial.hrtfHint') }
])
const modeHint = computed(() => modes.value.find(m => m.value === call.prefs.spatial)?.hint)

const testPaths = computed<{ value: TestPath; label: string }[]>(() => [
  { value: 'raw', label: t('settings.pathRaw') },
  // The app has no WebRTC audio stack of its own to test.
  ...(isNative ? [] : [{ value: 'webrtc' as const, label: t('settings.pathWebRTC') }]),
  ...(llSupported ? [{ value: 'll' as const, label: t('settings.pathLL') }] : [])
])
function pickPath(v: TestPath) {
  if (call.test.on) void startMicTest(v)
  else call.test.path = v
}
const testHint = computed(
  () => ({
    raw: t(isNative ? 'settings.hintRawApp' : 'settings.hintRawBrowser'),
    webrtc: t('settings.hintWebRTC'),
    ll: t('settings.hintLL')
  })[call.test.path]
)

const processing = computed(
  () =>
    [
      { key: 'echoCancellation', label: t('settings.echo') },
      { key: 'noiseSuppression', label: t('settings.noise') },
      { key: 'autoGainControl', label: t('settings.agc') }
    ] as const
)

// The app does its own processing, each with what it costs in delay.
const appProcessing = computed(() => [
  {
    key: 'echoCancellation' as const,
    label: t('settings.echo'),
    hint: t('settings.echoHint'),
    off: false
  },
  {
    key: 'noiseSuppression' as const,
    label: t('settings.noise'),
    hint:
      native.app?.noise === false
        ? t('settings.noiseNotBuilt')
        : t(call.prefs.noiseLookahead ? 'settings.noiseHintLookahead' : 'settings.noiseHint'),
    off: native.app?.noise === false
  },
  {
    key: 'autoGainControl' as const,
    label: t('settings.agc'),
    hint: t('settings.agcHint'),
    off: false
  }
])
const gatePct = computed(() => Math.round(call.prefs.noiseGate * 100))
function resetGain() {
  const d = DEFAULT_PREFS
  setAppDevices({ agcTargetDb: d.agcTargetDb, agcMaxDb: d.agcMaxDb, agcCeilingDb: d.agcCeilingDb, agcRiseMs: d.agcRiseMs, agcFallMs: d.agcFallMs })
}

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
  <div ref="el" v-snap class="panel" role="dialog" :aria-label="t('settings.title')">
    <header>
      <h2>{{ t('settings.title') }}</h2>
      <button type="button" class="x" :aria-label="t('common.close')" @click="emit('close')"><Icon name="close" :size="20" /></button>
    </header>
    <nav class="tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'voice'" :class="{ active: tab === 'voice' }" @click="tab = 'voice'">{{ t('settings.tabVoice') }}</button>
      <button type="button" role="tab" :aria-selected="tab === 'll'" :class="{ active: tab === 'll' }" @click="tab = 'll'">
        {{ t('settings.tabLL') }} <span class="badge">{{ t('common.beta') }}</span>
      </button>
      <button
        v-if="overlaySupported"
        type="button"
        role="tab"
        :aria-selected="tab === 'overlay'"
        :class="{ active: tab === 'overlay' }"
        @click="tab = 'overlay'"
      >
        {{ t('settings.tabOverlay') }}
      </button>
    </nav>
    <LLSettings v-if="tab === 'll'" />
    <OverlaySettings v-else-if="tab === 'overlay'" />
    <template v-else>

    <div class="row two">
      <label class="field">
        <span class="eyebrow">{{ t('settings.inputDevice') }}</span>
        <select :value="currentInput" @change="pickInput(($event.target as HTMLSelectElement).value)">
          <option v-for="(d, i) in inputs" :key="d.deviceId" :value="d.deviceId">{{ label(d, i, t('common.microphone')) }}</option>
          <option v-if="!inputs.length" value="default">{{ t('common.default') }}</option>
        </select>
      </label>
      <label v-if="canPickOutput" class="field">
        <span class="eyebrow">{{ t('settings.outputDevice') }}</span>
        <select :value="currentOutput" @change="pickOutput(($event.target as HTMLSelectElement).value)">
          <option v-for="(d, i) in outputs" :key="d.deviceId" :value="d.deviceId">{{ label(d, i, t('common.speaker')) }}</option>
          <option v-if="!outputs.length" value="default">{{ t('common.default') }}</option>
        </select>
      </label>
    </div>

    <div class="row">
      <span class="eyebrow">{{ t('settings.inputLevel') }}</span>
      <div class="meter" :class="{ dead: !!call.micProblem }">
        <div class="fill" :style="{ transform: `scaleX(${level})` }" />
      </div>

    <div class="row">
      <span class="eyebrow">{{ t('settings.micTest') }}</span>
      <p class="note first">
        {{ t('settings.micTestNote') }}
      </p>
      <Segmented
        :options="testPaths"
        :model-value="call.test.path"
        @update:model-value="pickPath"
      />
      <div class="test-row">
        <button type="button" class="test-btn" :class="{ stop: call.test.on }" @click="call.test.on ? stopMicTest() : startMicTest(call.test.path)">
          {{ call.test.on ? t('settings.stopTesting') : t('settings.startTesting') }}
        </button>
        <div v-if="call.test.on" class="test-out" aria-live="polite">
          <strong>{{ call.test.ms === null ? '…' : `${call.test.measured ? '' : '≈ '}${Math.round(call.test.ms)} ms` }}</strong>
          <span>{{ call.test.measured ? t('settings.testMicToEarsMeasured') : t('settings.testMicToEars') }}</span>
          <small v-if="call.test.detail">{{ call.test.detail }}</small>
        </div>
      </div>
      <p class="note">{{ testHint }}</p>
    </div>
      <p v-if="call.micProblem" class="note bad">
        {{ call.micProblem === 'denied' ? t('settings.micBlocked') : t('settings.micNone') }}
      </p>
    </div>

    <div class="row">
      <span class="eyebrow">{{ t('spatial.title') }}</span>
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
      <span class="eyebrow">{{ t('settings.processing') }}</span>
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
            :label="t('settings.lookahead')"
            :hint="t('settings.lookaheadHint')"
            :model-value="call.prefs.noiseLookahead"
            @update:model-value="v => setAppDevices({ noiseLookahead: v })"
          />
          <Slider
            :label="t('settings.gate')"
            unit="%"
            :min="0"
            :max="95"
            :step="5"
            :hint="
              gatePct === 0
                ? t('settings.gateOff')
                : t('settings.gateOn', { pct: gatePct })
            "
            :model-value="gatePct"
            @update:model-value="v => setAppDevices({ noiseGate: v / 100 })"
          />
          <Slider
            v-if="gatePct > 0"
            :label="t('settings.gateHold')"
            unit=" ms"
            :min="100"
            :max="1000"
            :step="50"
            :hint="t('settings.gateHoldHint')"
            :model-value="call.prefs.noiseGraceMs"
            @update:model-value="v => setAppDevices({ noiseGraceMs: v })"
          />
        </template>
        <template v-if="call.prefs.autoGainControl">
          <Slider
            :label="t('settings.agcTarget')"
            unit=" dBFS"
            :min="-30"
            :max="-10"
            :step="1"
            :hint="t('settings.agcTargetHint')"
            :model-value="call.prefs.agcTargetDb"
            @update:model-value="v => setAppDevices({ agcTargetDb: v })"
          />
          <Slider
            :label="t('settings.agcCeiling')"
            unit=" dBFS"
            :min="-12"
            :max="-1"
            :step="1"
            :hint="t('settings.agcCeilingHint')"
            :model-value="call.prefs.agcCeilingDb"
            @update:model-value="v => setAppDevices({ agcCeilingDb: v })"
          />
          <Slider
            :label="t('settings.agcMax')"
            unit=" dB"
            :min="0"
            :max="40"
            :step="1"
            :hint="t('settings.agcMaxHint')"
            :model-value="call.prefs.agcMaxDb"
            @update:model-value="v => setAppDevices({ agcMaxDb: v })"
          />
          <Slider
            :label="t('settings.agcRise')"
            unit=" ms"
            :min="100"
            :max="5000"
            :step="100"
            :hint="t('settings.agcRiseHint')"
            :model-value="call.prefs.agcRiseMs"
            @update:model-value="v => setAppDevices({ agcRiseMs: v })"
          />
          <Slider
            :label="t('settings.agcFall')"
            unit=" ms"
            :min="10"
            :max="500"
            :step="10"
            :hint="t('settings.agcFallHint')"
            :model-value="call.prefs.agcFallMs"
            @update:model-value="v => setAppDevices({ agcFallMs: v })"
          />
          <button type="button" class="reset-gain" @click="resetGain">{{ t('settings.resetGain') }}</button>
        </template>
        <p class="note spaced">{{ t('settings.appProcessingNote') }}</p>
      </template>
      <template v-else>
      <Switch
        v-for="p in processing"
        :key="p.key"
        :label="p.label"
        :model-value="call.prefs[p.key]"
        @update:model-value="v => applyMicPrefs({ [p.key]: v })"
      />
      <p class="note">{{ t('settings.browserProcessingNote') }}</p>
      </template>
      <Switch
        :label="t('settings.dtx')"
        :hint="t('settings.dtxHint')"
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
.reset-gain {
  margin: 4px 0 8px;
  border: 0;
  padding: 0;
  background: none;
  color: var(--text-link);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.reset-gain:hover {
  text-decoration: underline;
}
.note.spaced {
  margin: 4px 0 12px;
}
</style>
