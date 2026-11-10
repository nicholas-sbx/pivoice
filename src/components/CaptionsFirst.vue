<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { call } from '../call'
import { conversation } from '../captions/state'
import Avatar from './Avatar.vue'
import CaptionFirstSettings from './CaptionFirstSettings.vue'
import Icon from './Icon.vue'

defineProps<{ sidebar: boolean }>()
const emit = defineEmits<{ close: [] }>()
const p = computed(() => call.prefs.captionFirst)
const settings = ref(false)
const log = ref<HTMLElement>()
const panel = ref<HTMLElement>()
const following = ref(true)
const messages = computed(() => conversation.visibleMessages.filter(m =>
  !call.silenced[m.speaker] && (m.speaker !== call.selfId || call.prefs.captions.showOwn)
))
let observer: ResizeObserver | null = null
let sweep: ReturnType<typeof setInterval> | null = null

function pin() {
  if (following.value && log.value) log.value.scrollTop = log.value.scrollHeight
}
function onScroll() {
  const el = log.value
  if (el) following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
function jump() {
  following.value = true
  pin()
}
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  if (settings.value) settings.value = false
  else emit('close')
}
watch(messages, pin, { deep: true, flush: 'post' })
watch(settings, () => void nextTick(pin))
onMounted(() => {
  panel.value?.focus({ preventScroll: true })
  pin()
  observer = new ResizeObserver(pin)
  if (log.value) observer.observe(log.value)
  sweep = setInterval(() => conversation.tick(performance.now()), 250)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  if (sweep) clearInterval(sweep)
})
</script>

<template>
  <section
    class="captions-first"
    :class="{ sidebar }"
    :style="{ '--caption-dim': p.dim, '--caption-blur': p.blur + 'px', '--caption-scale': p.scale, '--message-spacing': p.spacing + 'px' }"
    aria-label="Captions first"
    @keydown="onKey"
  >
    <div ref="panel" class="caption-panel" tabindex="-1">
      <header class="caption-header">
        <Icon name="captions" :size="20" />
        <h2>Captions first</h2>
        <span class="live-label">LIVE</span>
        <button type="button" class="icon-button" aria-label="Caption appearance and timing" :aria-expanded="settings" @click="settings = !settings">
          <Icon name="gear" :size="18" />
        </button>
        <button type="button" class="icon-button" aria-label="Return to table" @click="emit('close')"><Icon name="close" :size="20" /></button>
      </header>
      <div v-if="settings" class="appearance" role="region" aria-label="Caption appearance and timing"><CaptionFirstSettings /></div>
      <!-- Rapid partial corrections deliberately aren't live announcements. -->
      <div ref="log" class="conversation" role="region" aria-label="Call captions" tabindex="0" @scroll="onScroll">
        <div v-if="!messages.length" class="empty">
          <Icon name="captions" :size="32" />
          <strong>The conversation starts here</strong>
          <p>Words appear as people speak. Each person captions their own voice with Caption Me.</p>
        </div>
        <ol v-else class="messages">
          <li v-for="m in messages" :key="m.id" class="message" :class="{ waiting: m.waiting }" :style="{ '--speaker-color': m.color }" :data-message-id="m.id">
            <Avatar :name="m.name" :size="28" :hue="m.hue" />
            <div class="message-content">
              <div class="message-author"><strong>{{ m.name }}</strong><span v-if="m.speaker === call.selfId" class="you">you</span></div>
              <p class="message-text" :class="{ tinted: p.tint }">{{ m.text }}<span v-if="p.indicator && m.waiting" class="waiting-dots" role="img" aria-label="Waiting for words"><i /><i /><i /></span><span v-else-if="!m.text" class="waiting-label">Speaking…</span></p>
            </div>
          </li>
        </ol>
      </div>
      <footer class="caption-footer">
        <span>Live captions can make mistakes.</span>
        <button v-if="!following" type="button" class="jump" @click="jump">Jump to latest <Icon name="arrow" :size="14" /></button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.captions-first {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  justify-content: center;
  padding: 20px max(12px, env(safe-area-inset-left)) calc(112px + env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-right));
}
.captions-first::before {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(7, 8, 10, var(--caption-dim));
  -webkit-backdrop-filter: blur(var(--caption-blur));
  backdrop-filter: blur(var(--caption-blur));
}
.caption-panel {
  position: relative;
  width: min(100%, 760px);
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary-alt);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
}
.caption-panel:focus { outline: none; }
.caption-header { display: flex; align-items: center; gap: 10px; flex: none; padding: 12px 16px; border-bottom: 1px solid var(--border-strong); color: var(--header-secondary); }
h2 { margin: 0; flex: 1; min-width: 0; color: var(--header-primary); font-size: 15px; line-height: 20px; font-weight: 600; }
.live-label { font-size: 10px; font-weight: 700; letter-spacing: .06em; color: var(--green); }
.icon-button { display: grid; place-items: center; flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--interactive-normal); cursor: pointer; }
.icon-button:hover, .icon-button[aria-expanded='true'] { background: var(--bg-modifier-hover); color: var(--header-primary); }
.appearance { flex: 0 1 auto; min-height: 0; max-height: 60%; overflow-y: auto; padding: 8px 16px; border-bottom: 1px solid var(--border-strong); }
.conversation { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; overflow-anchor: none; padding: 16px; scroll-padding: 16px; }
.messages { list-style: none; margin: 0; padding: 0; }
.message { display: flex; align-items: flex-start; gap: 10px; padding: 5px 0; margin-top: var(--message-spacing); }
.message:first-child { margin-top: 0; }
.message-content { min-width: 0; flex: 1; }
.message-author { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; font-size: 12px; line-height: 16px; overflow-wrap: anywhere; color: var(--speaker-color); }
.message-author strong { font-weight: 600; }
.you { color: var(--text-muted); font-size: 10px; }
.message-text { margin: 0; font-size: calc(15px * var(--caption-scale)); line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-normal); }
.message-text.tinted { color: var(--speaker-color); }
.waiting-dots { display: inline-flex; align-items: center; gap: 3px; height: 1em; margin-left: .4em; vertical-align: -.1em; }
.waiting-dots i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; animation: waiting-dot 1.2s ease-in-out infinite; }
.waiting-dots i:nth-child(2) { animation-delay: .15s; }
.waiting-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes waiting-dot { 0%, 70%, 100% { opacity: .3; } 35% { opacity: 1; } }
.waiting-label { color: var(--text-muted); font-size: 13px; }
.empty { min-height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; gap: 10px; color: var(--text-muted); padding: 16px; }
.empty strong { font-size: 15px; color: var(--header-secondary); }
.empty p { margin: 0; max-width: 320px; font-size: 13px; }
.caption-footer { flex: none; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; padding: 8px 16px; border-top: 1px solid var(--border-subtle); font-size: 11px; color: var(--text-muted); }
.jump { display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; color: var(--text-link); font-size: 12px; cursor: pointer; padding: 0; }
.sidebar { left: auto; width: var(--caption-sidebar-width); padding: 0; }
.sidebar::before { display: none; }
.sidebar .caption-panel { width: 100%; border-radius: 0; border-width: 0 0 0 1px; }
@media (max-width: 480px) {
  .captions-first { padding-top: 8px; padding-bottom: calc(108px + env(safe-area-inset-bottom)); }
  .caption-header { padding: 8px 10px; gap: 6px; }
  .live-label { display: none; }
  .conversation { padding: 12px; }
  .caption-footer { padding: 6px 12px; }
}
@media (max-height: 520px) {
  .captions-first:not(.sidebar) { padding-top: 4px; padding-bottom: calc(100px + env(safe-area-inset-bottom)); }
  .caption-header { padding-top: 4px; padding-bottom: 4px; }
  .caption-footer { padding-top: 3px; padding-bottom: 3px; }
}
@media (prefers-reduced-motion: reduce) { .waiting-dots i { animation: none; } }
</style>
