<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { MAX_VOLUME } from '../audio/engine'
import { call, setSilenced, setVolume } from '../call'
import { vSnap } from '../lib/snap'

/** Right-click on someone: Discord's user context menu, cut down to what a voice call needs. */

const props = defineProps<{ id: string; x: number; y: number }>()
const emit = defineEmits<{ close: [] }>()

const el = ref<HTMLElement>()
const pos = ref({ left: props.x, top: props.y })
const member = computed(() => call.members.find(m => m.id === props.id))
const volume = computed(() => Math.round((call.volumes[props.id] ?? 1) * 100))
const max = MAX_VOLUME * 100
// 100% sits in the middle of the track, and the slider sticks to it on the way past.
const SNAP = 6

function onVolume(e: Event) {
  let v = Number((e.target as HTMLInputElement).value)
  if (Math.abs(v - 100) <= SNAP) v = 100
  setVolume(props.id, v / 100)
}
function reset() {
  setVolume(props.id, 1)
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
  <div ref="el" v-snap class="menu" role="menu" :style="{ left: pos.left + 'px', top: pos.top + 'px' }" @contextmenu.prevent>
    <div class="who">{{ member?.name ?? 'Left the call' }}</div>
    <div class="sep" />
    <div class="item slider">
      <span class="top">
        <label class="label" :for="`vol-${id}`">User Volume</label>
        <button v-if="volume !== 100" type="button" class="reset" title="Back to 100%" @click="reset">Reset</button>
      </span>
      <div class="track">
        <input
          :id="`vol-${id}`"
          type="range"
          min="0"
          :max="max"
          step="1"
          :value="volume"
          :style="{ '--fill': (volume / max) * 100 + '%' }"
          :aria-valuetext="`${volume}%`"
          @input="onVolume"
          @dblclick="reset"
        />
        <!-- Where 100% is: the snap point. -->
        <span class="mark" aria-hidden="true" />
      </div>
      <span class="value" :class="{ loud: volume > 100 }">{{ volume }}%</span>
    </div>
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
  min-width: 240px;
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
.top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.label {
  color: var(--interactive-normal);
}
.reset {
  border: 0;
  padding: 0;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-link);
  cursor: pointer;
}
.reset:hover {
  text-decoration: underline;
}
.track {
  position: relative;
  display: flex;
  align-items: center;
  height: 24px;
}
.mark {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 2px;
  height: 14px;
  margin: -7px 0 0 -1px;
  border-radius: 1px;
  background: var(--text-muted);
  pointer-events: none;
  opacity: 0.7;
}
.value {
  align-self: flex-end;
  font-size: 12px;
  color: var(--text-muted);
  margin-top: -2px;
  font-variant-numeric: tabular-nums;
}
.value.loud {
  color: var(--yellow);
}
input[type='range'] {
  position: relative;
  z-index: 1;
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
