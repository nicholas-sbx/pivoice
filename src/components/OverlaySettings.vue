<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { call, updatePrefs } from '../call'
import type { OverlayPrefs } from '../lib/prefs'
import { native } from '../native/bridge'
import { listMonitors, overlayError, overlayPlacing } from '../native/overlay'
import type { AppMonitor, OverlayAnchor, OverlayNeeds } from '../native/protocol'
import Slider from './Slider.vue'
import Switch from './Switch.vue'

/**
 * The overlay's settings: on or off, which screen, which side of it, how
 * far in, how big (and how big the faces in it), how faded. While they're open the overlay shows its
 * edges, and every change moves it straight away, so you place it by
 * watching it.
 */

const o = computed(() => call.prefs.overlay)
const set = (patch: Partial<OverlayPrefs>) => updatePrefs({ overlay: { ...call.prefs.overlay, ...patch } })

const monitors = ref<AppMonitor[]>([])
const placeable = ref(true)
const onTop = ref(true)
const needs = ref<OverlayNeeds | undefined>()

onMounted(async () => {
  overlayPlacing.value = true
  const r = await listMonitors()
  monitors.value = r.monitors
  placeable.value = r.placeable
  onTop.value = r.onTop
  needs.value = r.needs
})
onBeforeUnmount(() => {
  overlayPlacing.value = false
})

/** The screen it'll go on: the one picked, or the one this window's on, or the primary one. */
const screen = computed(
  () => monitors.value.find(m => m.id === o.value.monitor) ?? monitors.value.find(m => m.current) ?? monitors.value.find(m => m.primary) ?? null
)
const missing = computed(() => !!o.value.monitor && monitors.value.length > 0 && !monitors.value.some(m => m.id === o.value.monitor))
const label = (m: AppMonitor) => `${m.name} (${m.width} × ${m.height})${m.primary ? ', primary' : ''}`

const anchors: { value: OverlayAnchor; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top', label: 'Top' },
  { value: 'top-right', label: 'Top right' },
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Middle' },
  { value: 'right', label: 'Right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'bottom-right', label: 'Bottom right' }
]

/** The screen in miniature, its own shape. */
const shape = computed(() => {
  const w = screen.value?.width || 1920
  const h = screen.value?.height || 1080
  // As wide as the panel, but no taller than 240 px (a screen on its side).
  return { w, h, style: { aspectRatio: `${w} / ${h}`, width: `min(100%, ${Math.round((240 * w) / h)}px)` } }
})

/** Where the overlay would sit on that screen at a side, to scale. */
function boxAt(a: OverlayAnchor) {
  const { w, h } = shape.value
  const size = o.value.size
  const left = a.endsWith('left') ? o.value.margin : a.endsWith('right') ? w - size - o.value.margin : (w - size) / 2
  const top = a.startsWith('top') ? o.value.margin : a.startsWith('bottom') ? h - size - o.value.margin : (h - size) / 2
  const pct = (v: number, of: number) => ((100 * v) / of).toFixed(2) + '%'
  return { left: pct(left, w), top: pct(top, h), width: pct(size, w), height: pct(size, h) }
}

/** The side the pointer (or the keyboard) is on, to show where it would go before you pick it. */
const peek = ref<OverlayAnchor | null>(null)
const peeked = computed(() => (peek.value && peek.value !== o.value.anchor ? boxAt(peek.value) : null))
const sideLabel = computed(() => anchors.find(a => a.value === (peek.value ?? o.value.anchor))?.label ?? '')
</script>

<template>
  <div class="overlay-settings">
    <Switch
      label="Show overlay"
      hint="The table, small, over everything else on your screen while you're in a call. Clicks go straight through it."
      :model-value="o.on"
      @update:model-value="v => set({ on: v })"
    />
    <p v-if="o.on && overlayError" class="note error">Couldn't show it: {{ overlayError }}</p>
    <p v-if="!onTop && needs === 'gtk-layer-shell'" class="note">
      To keep it on top and let clicks through, this desktop needs gtk-layer-shell, which isn't installed: <code>libgtk-layer-shell0</code>
      on Debian and Ubuntu, <code>gtk-layer-shell</code> on Fedora and Arch. Then switch the overlay off and on again. Until then it's an
      ordinary window, and takes clicks.
    </p>
    <p v-else-if="!onTop && needs === 'not-in-flatpak'" class="note">
      To keep it on top and let clicks through, this desktop needs gtk-layer-shell, which the Flatpak doesn't have yet: use the
      <code>.tar.gz</code> build of the app for that. Here it's an ordinary window, and takes clicks.
    </p>
    <p v-else-if="!onTop" class="note">
      This desktop (GNOME) doesn't let apps keep a window on top or say where it goes. Move the overlay with Super and drag, and pin it with
      Alt+Space, Always on Top. It takes clicks here, so you can.
    </p>
    <p v-if="native.app?.os === 'windows'" class="note">
      Over games too: borderless or windowed full screen, and most that say exclusive (Windows runs them through the desktop anyway).
      Not over a game in true exclusive full screen, which draws past the desktop altogether: if it doesn't show, set the game to
      borderless, or leave Windows' fullscreen optimizations on for it.
    </p>

    <label class="field">
      <span class="eyebrow">Screen</span>
      <select :value="missing ? '' : o.monitor" :disabled="!placeable" @change="set({ monitor: ($event.target as HTMLSelectElement).value })">
        <option value="">The one Pivoice is on</option>
        <option v-for="m in monitors" :key="m.id" :value="m.id">{{ label(m) }}</option>
      </select>
    </label>
    <p v-if="missing" class="note">The screen you picked isn't connected, so it's on the one Pivoice is on until it is.</p>

    <span class="eyebrow">Position</span>
    <div class="map" :class="{ disabled: !placeable }" :style="shape.style" @mouseleave="peek = null">
      <div class="grid" role="radiogroup" aria-label="Position">
        <button
          v-for="a in anchors"
          :key="a.value"
          type="button"
          role="radio"
          :disabled="!placeable"
          :aria-checked="o.anchor === a.value"
          :aria-label="a.label"
          :title="a.label"
          :class="{ active: o.anchor === a.value }"
          @mouseenter="peek = a.value"
          @focus="peek = a.value"
          @blur="peek = null"
          @click="set({ anchor: a.value })"
        />
      </div>
      <div v-if="peeked" class="ghost" :style="peeked" />
      <div class="shown" :style="boxAt(o.anchor)" />
    </div>
    <p class="side">{{ sideLabel }}</p>

    <Slider
      label="Distance from the edge"
      :model-value="o.margin"
      :min="0"
      :max="200"
      :step="2"
      unit=" px"
      :disabled="o.anchor === 'center'"
      hint="From the part of the screen windows get, so it never sits under a taskbar or panel. Not used in the middle, which has no edge."
      @update:model-value="v => set({ margin: v })"
    />
    <Slider label="Size" :model-value="o.size" :min="160" :max="600" :step="10" unit=" px" hint="Its width and height." @update:model-value="v => set({ size: v })" />
    <Slider
      label="Scale"
      :model-value="Math.round(o.scale * 100)"
      :min="75"
      :max="150"
      :step="5"
      unit="%"
      hint="How big the faces and names are in it."
      @update:model-value="v => set({ scale: v / 100 })"
    />
    <Slider
      label="Opacity"
      :model-value="Math.round(o.opacity * 100)"
      :min="20"
      :max="100"
      :step="5"
      unit="%"
      hint="The table and anyone quiet. Whoever's speaking always shows in full."
      @update:model-value="v => set({ opacity: v / 100 })"
    />
  </div>
</template>

<style scoped>
.eyebrow {
  display: block;
  margin: 16px 0 8px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--header-secondary);
}
.field {
  display: block;
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
}
select:disabled {
  opacity: 0.5;
}
.note {
  margin: 4px 0;
  font-size: 12px;
  color: var(--text-muted);
}
.note.error {
  color: var(--red);
}

/* The screen, seen small: a hard edge round it, nine sides to pick from with the lines between them, the overlay where it'll be. */
.map {
  position: relative;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--border-subtle);
  overflow: hidden;
}
.map.disabled {
  opacity: 0.5;
}
.grid {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template: repeat(3, 1fr) / repeat(3, 1fr);
  gap: 1px;
}
.grid button {
  border: 0;
  padding: 0;
  background: var(--bg-tertiary);
  cursor: pointer;
}
.grid button:hover:not(:disabled) {
  background: var(--bg-secondary);
}
.grid button.active {
  background: rgba(88, 101, 242, 0.12);
}
.grid button:disabled {
  cursor: default;
}
.grid button:focus-visible {
  outline-offset: -2px;
}
/* The overlay (a square, with the round table in it) where it is, and a hairline one where the pointer is. */
.shown,
.ghost {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
}
.shown {
  border: 1px solid var(--brand);
  background: rgba(88, 101, 242, 0.35);
}
.shown::after {
  content: '';
  position: absolute;
  inset: 14%;
  border: 1px solid var(--brand-soft);
  border-radius: 50%;
}
.ghost {
  border: 1px dashed var(--brand-soft);
}
.side {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}
</style>
