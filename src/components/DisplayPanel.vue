<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { call, updatePrefs } from '../call'
import Switch from './Switch.vue'
import { vSnap } from '../lib/snap'

/** What the table shows about everyone's connection. Pops down from the top bar. */

const emit = defineEmits<{ close: [] }>()
const el = ref<HTMLElement>()

function onDown(e: PointerEvent) {
  const t = e.target as HTMLElement
  if (el.value && !el.value.contains(t) && !t.closest('[data-display-toggle]')) emit('close')
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  addEventListener('pointerdown', onDown, true)
  addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  removeEventListener('pointerdown', onDown, true)
  removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="el" v-snap class="panel" role="dialog" aria-label="Display settings">
    <span class="eyebrow">At the table</span>
    <Switch
      label="Show ping"
      hint="Round trip to each person, beside their name."
      :model-value="call.prefs.showPing"
      @update:model-value="v => updatePrefs({ showPing: v })"
    />
    <Switch
      label="Show audio route"
      hint="How each person's audio reaches you: direct or relayed, buffering, loss."
      :model-value="call.prefs.showRoute"
      @update:model-value="v => updatePrefs({ showRoute: v })"
    />
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 340px;
  padding: 12px 16px 10px;
  border-radius: 8px;
  background: var(--bg-floating);
  box-shadow: var(--elevation-high), var(--elevation-stroke);
  z-index: 20;
}
@media (max-width: 640px), (pointer: coarse) and (max-height: 520px) {
  .panel {
    position: fixed;
    top: calc(60px + env(safe-area-inset-top));
    left: calc(8px + env(safe-area-inset-left));
    right: calc(8px + env(safe-area-inset-right));
    width: auto;
  }
}
.eyebrow {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--header-secondary);
}
</style>
