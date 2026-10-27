<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { AudioEngine, type SpatialMode } from '../audio/engine'
import { applyMicPrefs, call, getEngine, setOutput, setSpatial } from '../call'
import Icon from './Icon.vue'

/** Voice settings, popping up over the call controls. */

const emit = defineEmits<{ close: [] }>()

const el = ref<HTMLElement>()
const inputs = ref<MediaDeviceInfo[]>([])
const outputs = ref<MediaDeviceInfo[]>([])
const level = ref(0)
const canPickOutput = AudioEngine.canPickOutput()
let raf = 0

async function loadDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    inputs.value = all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications')
    outputs.value = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications')
  } catch {
    inputs.value = []
    outputs.value = []
  }
}

const currentInput = computed(() => call.prefs.inputId || getEngine()?.micDeviceId || 'default')

function label(d: MediaDeviceInfo, i: number, kind: string) {
  return d.label || `${kind} ${i + 1}`
}

const modes: { value: SpatialMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Straight to your ears. Lowest latency.' },
  { value: 'stereo', label: 'Stereo', hint: 'Panned left and right by where people sit.' },
  { value: 'hrtf', label: 'HRTF', hint: 'Full 3D around your head, on headphones.' }
]
const modeHint = computed(() => modes.find(m => m.value === call.prefs.spatial)?.hint)

const processing = [
  { key: 'echoCancellation', label: 'Echo Cancellation' },
  { key: 'noiseSuppression', label: 'Noise Suppression' },
  { key: 'autoGainControl', label: 'Automatic Gain Control' }
] as const

function meter() {
  level.value = getEngine()?.micLevel() ?? 0
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
})
</script>

<template>
  <div ref="el" class="panel" role="dialog" aria-label="Voice settings">
    <header>
      <h2>Voice Settings</h2>
      <button type="button" class="x" aria-label="Close" @click="emit('close')"><Icon name="close" :size="20" /></button>
    </header>

    <div class="row two">
      <label class="field">
        <span class="eyebrow">Input Device</span>
        <select :value="currentInput" @change="applyMicPrefs({ inputId: ($event.target as HTMLSelectElement).value })">
          <option v-for="(d, i) in inputs" :key="d.deviceId" :value="d.deviceId">{{ label(d, i, 'Microphone') }}</option>
          <option v-if="!inputs.length" value="default">Default</option>
        </select>
      </label>
      <label v-if="canPickOutput" class="field">
        <span class="eyebrow">Output Device</span>
        <select :value="call.prefs.outputId || 'default'" @change="setOutput(($event.target as HTMLSelectElement).value)">
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
      <label v-for="p in processing" :key="p.key" class="switch-row">
        <span>{{ p.label }}</span>
        <span class="switch" :class="{ on: call.prefs[p.key] }">
          <input
            type="checkbox"
            class="sr-only"
            :checked="call.prefs[p.key]"
            @change="applyMicPrefs({ [p.key]: ($event.target as HTMLInputElement).checked })"
          />
          <span class="knob" />
        </span>
      </label>
      <p class="note">Off for the lowest latency. Turn them on if you're not on headphones.</p>
    </div>
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  bottom: calc(100% + 14px);
  left: 50%;
  transform: translateX(-50%);
  width: 440px;
  padding: 16px;
  border-radius: 8px;
  background: var(--bg-primary);
  box-shadow: var(--elevation-high), var(--elevation-stroke);
  text-align: left;
  cursor: default;
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
.note {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}
.note.bad {
  color: var(--red);
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--header-primary);
  cursor: pointer;
}
.switch {
  position: relative;
  width: 40px;
  height: 24px;
  border-radius: 14px;
  background: #80848e;
  transition: background-color 0.2s ease;
  flex: none;
}
.switch.on {
  background: var(--green);
}
.knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s ease;
}
.switch.on .knob {
  transform: translateX(16px);
}
.switch:has(input:focus-visible) {
  outline: 2px solid var(--text-link);
  outline-offset: 2px;
}
</style>
