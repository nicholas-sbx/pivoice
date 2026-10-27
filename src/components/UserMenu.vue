<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { call, setSilenced, setVolume } from '../call'

/** Right-click on someone: Discord's user context menu, cut down to what a voice call needs. */

const props = defineProps<{ id: string; x: number; y: number }>()
const emit = defineEmits<{ close: [] }>()

const el = ref<HTMLElement>()
const pos = ref({ left: props.x, top: props.y })
const member = computed(() => call.members.find(m => m.id === props.id))
const volume = computed(() => Math.round((call.volumes[props.id] ?? 1) * 100))

function onVolume(e: Event) {
  setVolume(props.id, Number((e.target as HTMLInputElement).value) / 100)
}

function onDown(e: PointerEvent) {
  if (el.value && !el.value.contains(e.target as Node)) emit('close')
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(async () => {
  await nextTick()
  // Keep it on screen.
  const r = el.value!.getBoundingClientRect()
  pos.value = {
    left: Math.min(props.x, innerWidth - r.width - 8),
    top: Math.min(props.y, innerHeight - r.height - 8)
  }
  addEventListener('pointerdown', onDown, true)
  addEventListener('keydown', onKey)
  addEventListener('blur', () => emit('close'), { once: true })
})
onBeforeUnmount(() => {
  removeEventListener('pointerdown', onDown, true)
  removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="el" class="menu" role="menu" :style="{ left: pos.left + 'px', top: pos.top + 'px' }" @contextmenu.prevent>
    <div class="who">{{ member?.name ?? 'Left the call' }}</div>
    <div class="sep" />
    <label class="item slider">
      <span class="label">User Volume</span>
      <input type="range" min="0" max="100" step="1" :value="volume" :style="{ '--fill': volume + '%' }" @input="onVolume" />
      <span class="value">{{ volume }}%</span>
    </label>
    <div class="sep" />
    <button type="button" class="item check" role="menuitemcheckbox" :aria-checked="!!call.silenced[id]" @click="setSilenced(id, !call.silenced[id])">
      <span>Mute</span>
      <span class="box" :class="{ checked: call.silenced[id] }">
        <svg v-if="call.silenced[id]" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
      </span>
    </button>
  </div>
</template>

<style scoped>
.menu {
  position: fixed;
  z-index: 60;
  min-width: 220px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--bg-floating);
  box-shadow: var(--elevation-high), var(--elevation-stroke);
  font-size: 14px;
  font-weight: 500;
}
.who {
  padding: 6px 8px;
  color: var(--header-primary);
  font-weight: 600;
}
.sep {
  height: 1px;
  margin: 4px;
  background: rgba(78, 80, 88, 0.48);
}
.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 32px;
  padding: 6px 8px;
  margin: 2px 0;
  border: 0;
  border-radius: 2px;
  background: none;
  color: var(--interactive-normal);
  text-align: left;
  cursor: pointer;
}
.item.check:hover {
  background: var(--brand);
  color: #fff;
}
.slider {
  flex-direction: column;
  align-items: stretch;
  cursor: default;
  gap: 6px;
}
.label {
  color: var(--interactive-normal);
}
.value {
  align-self: flex-end;
  font-size: 12px;
  color: var(--text-muted);
  margin-top: -4px;
}
input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: linear-gradient(to right, var(--brand) var(--fill), var(--bg-accent) var(--fill));
  cursor: pointer;
}
input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 24px;
  border-radius: 3px;
  background: #fff;
  border: 1px solid #dcddde;
  box-shadow: 0 3px 1px 0 rgba(0, 0, 0, 0.05), 0 2px 2px 0 rgba(0, 0, 0, 0.1), 0 3px 3px 0 rgba(0, 0, 0, 0.05);
}
input[type='range']::-moz-range-thumb {
  width: 10px;
  height: 24px;
  border-radius: 3px;
  background: #fff;
  border: 1px solid #dcddde;
}
.box {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: 1px solid var(--interactive-normal);
  display: grid;
  place-items: center;
}
.box.checked {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}
.item.check:hover .box {
  border-color: #fff;
}
</style>
