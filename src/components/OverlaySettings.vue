<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { call, updatePrefs } from '../call'
import { t } from '../i18n'
import type { OverlayPrefs } from '../lib/prefs'
import { native } from '../native/bridge'
import { listMonitors, overlayError, overlayPlacing } from '../native/overlay'
import type { AppMonitor, OverlayAnchor } from '../native/protocol'
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

onMounted(async () => {
  overlayPlacing.value = true
  const r = await listMonitors()
  monitors.value = r.monitors
  placeable.value = r.placeable
  onTop.value = r.onTop
})
onBeforeUnmount(() => {
  overlayPlacing.value = false
})

/** The screen it'll go on: the one picked, or the one this window's on, or the primary one. */
const screen = computed(
  () => monitors.value.find(m => m.id === o.value.monitor) ?? monitors.value.find(m => m.current) ?? monitors.value.find(m => m.primary) ?? null
)
const missing = computed(() => !!o.value.monitor && monitors.value.length > 0 && !monitors.value.some(m => m.id === o.value.monitor))
const label = (m: AppMonitor) => {
  const text = t('overlay.screenLabel', { name: m.name, width: m.width, height: m.height })
  return m.primary ? t('overlay.screenPrimary', { label: text }) : text
}

const anchors: OverlayAnchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']

/** The screen in miniature, its own shape, and the overlay on it where it'll be, to scale. */
const map = computed(() => {
  const w = screen.value?.width || 1920
  const h = screen.value?.height || 1080
  const size = o.value.size
  const a = o.value.anchor
  const left = a.endsWith('left') ? o.value.margin : a.endsWith('right') ? w - size - o.value.margin : (w - size) / 2
  const top = a.startsWith('top') ? o.value.margin : a.startsWith('bottom') ? h - size - o.value.margin : (h - size) / 2
  const pct = (v: number, of: number) => ((100 * v) / of).toFixed(2) + '%'
  return {
    // As wide as the panel, but no taller than 240 px (a screen on its side).
    style: { aspectRatio: `${w} / ${h}`, width: `min(100%, ${Math.round((240 * w) / h)}px)` },
    box: { left: pct(left, w), top: pct(top, h), width: pct(size, w), height: pct(size, h) }
  }
})
</script>

<template>
  <div class="overlay-settings">
    <Switch
      :label="t('overlay.show')"
      :hint="t('overlay.showHint')"
      :model-value="o.on"
      @update:model-value="v => set({ on: v })"
    />
    <p v-if="o.on && overlayError" class="note error">{{ t('overlay.error', { error: overlayError }) }}</p>
    <p v-if="!onTop" class="note">
      {{ t('overlay.gnome') }}
    </p>
    <p v-if="native.app?.os === 'windows'" class="note">
      {{ t('overlay.windows') }}
    </p>

    <label class="field">
      <span class="eyebrow">{{ t('overlay.screen') }}</span>
      <select :value="missing ? '' : o.monitor" :disabled="!placeable" @change="set({ monitor: ($event.target as HTMLSelectElement).value })">
        <option value="">{{ t('overlay.screenCurrent') }}</option>
        <option v-for="m in monitors" :key="m.id" :value="m.id">{{ label(m) }}</option>
      </select>
    </label>
    <p v-if="missing" class="note">{{ t('overlay.screenMissing') }}</p>

    <span class="eyebrow">{{ t('overlay.position') }}</span>
    <div class="map" :class="{ disabled: !placeable }" :style="map.style">
      <div class="shown" :style="map.box" />
      <div class="grid" role="radiogroup" :aria-label="t('overlay.position')">
        <button
          v-for="a in anchors"
          :key="a"
          type="button"
          role="radio"
          :disabled="!placeable"
          :aria-checked="o.anchor === a"
          :aria-label="t(`overlay.anchor.${a}`)"
          :title="t(`overlay.anchor.${a}`)"
          :class="{ active: o.anchor === a }"
          @click="set({ anchor: a })"
        >
          <span class="dot" />
        </button>
      </div>
    </div>

    <Slider
      :label="t('overlay.margin')"
      :model-value="o.margin"
      :min="0"
      :max="200"
      :step="2"
      unit=" px"
      :hint="t(o.anchor === 'center' ? 'overlay.marginCenter' : 'overlay.marginHint')"
      @update:model-value="v => set({ margin: v })"
    />
    <Slider :label="t('overlay.size')" :model-value="o.size" :min="160" :max="600" :step="10" unit=" px" :hint="t('overlay.sizeHint')" @update:model-value="v => set({ size: v })" />
    <Slider
      :label="t('overlay.scale')"
      :model-value="Math.round(o.scale * 100)"
      :min="75"
      :max="150"
      :step="5"
      unit="%"
      :hint="t('overlay.scaleHint')"
      @update:model-value="v => set({ scale: v / 100 })"
    />
    <Slider
      :label="t('overlay.opacity')"
      :model-value="Math.round(o.opacity * 100)"
      :min="20"
      :max="100"
      :step="5"
      unit="%"
      :hint="t('overlay.opacityHint')"
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

/* The screen, seen small: a hard edge round it, the overlay where it'll be. */
.map {
  position: relative;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--bg-tertiary);
  overflow: hidden;
}
.map.disabled {
  opacity: 0.5;
}
.shown {
  position: absolute;
  border: 1px solid var(--brand);
  background: rgba(88, 101, 242, 0.25);
  pointer-events: none;
}
.grid {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template: repeat(3, 1fr) / repeat(3, 1fr);
}
.grid button {
  display: grid;
  place-items: center;
  border: 0;
  padding: 0;
  background: none;
  cursor: pointer;
}
.grid button:disabled {
  cursor: default;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--interactive-normal);
}
.grid button:hover:not(:disabled) .dot {
  border-color: var(--interactive-hover);
}
.grid button.active .dot {
  border-color: var(--brand);
  background: var(--brand);
}
</style>
