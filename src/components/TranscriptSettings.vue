<script setup lang="ts">
import { computed } from 'vue'
import { call, updatePrefs } from '../call'
import { CAPTION_FIRST_DEFAULTS, type CaptionFirstPrefs } from '../captions/conversation-config'
import Segmented from './Segmented.vue'
import Slider from './Slider.vue'
import Switch from './Switch.vue'

const p = computed(() => call.prefs.captionFirst)
const set = <K extends keyof CaptionFirstPrefs>(key: K, value: CaptionFirstPrefs[K]) =>
  updatePrefs({ captionFirst: { ...p.value, [key]: value } })
const layouts = [{ value: 'overlay' as const, label: 'Overlay' }, { value: 'sidebar' as const, label: 'Sidebar when it fits' }]
const colors = [
  { value: 'none' as const, label: 'None' },
  { value: 'highlight' as const, label: 'Highlight' },
  { value: 'text' as const, label: 'Text color' }
]
</script>

<template>
  <div class="transcript-settings">
    <Switch label="Transcript" hint="Read the call as a conversation. The table's captions move here while this is open." :model-value="p.on" @update:model-value="v => set('on', v)" />
    <Segmented label="Layout" :options="layouts" :model-value="p.layout" @update:model-value="v => set('layout', v)" />
    <p class="note">The sidebar needs room for the table beside it. Narrow windows use the overlay.</p>
    <Slider label="Append after a pause" unit=" s" :min="0" :max="30" :model-value="p.mergeSec" hint="Keep your last message if nobody else started speaking in between. Zero starts a new message after every pause." @update:model-value="v => set('mergeSec', v)" />
    <Slider label="Wait for words" unit=" s" :min="1" :max="15" :model-value="p.waitSec" hint="How long the dots stay after speech stops while recognition catches up." @update:model-value="v => set('waitSec', v)" />
    <Switch label="Waiting dots" hint="Show when someone is speaking or more words may be coming." :model-value="p.indicator" @update:model-value="v => set('indicator', v)" />
    <Segmented label="Speaker color" :options="colors" :model-value="p.color" @update:model-value="v => set('color', v)" />
    <p class="note">Highlight adds a subtle background to each message. Text color matches the small avatar. Each person's color stays fixed while they're in the call.</p>
    <Slider label="Text size" unit="%" :min="75" :max="175" :step="5" :model-value="Math.round(p.scale * 100)" @update:model-value="v => set('scale', v / 100)" />
    <Slider label="Message spacing" unit=" px" :min="0" :max="20" :model-value="p.spacing" @update:model-value="v => set('spacing', v)" />
    <Slider label="Messages to keep" :min="20" :max="300" :step="10" :model-value="p.history" hint="Only in this call, on this device. Leaving clears the conversation." @update:model-value="v => set('history', v)" />
    <Slider label="Backdrop darkness" unit="%" :min="20" :max="95" :step="5" :model-value="Math.round(p.dim * 100)" @update:model-value="v => set('dim', v / 100)" />
    <Slider label="Backdrop blur" unit=" px" :min="0" :max="20" :model-value="p.blur" @update:model-value="v => set('blur', v)" />
    <button type="button" class="reset" @click="updatePrefs({ captionFirst: { ...CAPTION_FIRST_DEFAULTS, on: p.on } })">Reset appearance and timing</button>
  </div>
</template>

<style scoped>
.note { margin: 0 0 8px; font-size: 12px; color: var(--text-muted); }
.reset { border: 0; background: none; padding: 8px 0; color: var(--text-link); font-size: 13px; cursor: pointer; }
.reset:hover { text-decoration: underline; }
</style>
