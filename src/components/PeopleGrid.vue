<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { layoutTiles, TILE_GAP } from '../lib/tiles'
import { touchFirst } from '../lib/viewport'
import type { Member } from '../net/protocol'
import { pingLevel, routeLabel, type LinkStats } from '../net/stats'
import Avatar from './Avatar.vue'
import Icon from './Icon.vue'

/**
 * Everyone as tiles, for small screens while spatial audio is off (seats
 * only matter for where people sound from, and a table is a lot of empty
 * felt on a phone). The tiles are as big as the screen and the head count
 * allow (lib/tiles): a few people get big tiles, a full room gets a list.
 */

const props = defineProps<{
  members: Member[]
  selfId: string
  speaking: Set<string>
  selfMuted: boolean
  selfDeafened: boolean
  silenced: Record<string, boolean>
  links: Record<string, LinkStats>
  showPing: boolean
  showRoute: boolean
}>()

const emit = defineEmits<{ menu: [id: string, x: number, y: number] }>()

const root = ref<HTMLElement>()
const size = reactive({ w: 0, h: 0 })

/** You first, then everyone in the order they joined. */
const people = computed(() => {
  const self = props.members.find(m => m.id === props.selfId)
  const others = props.members.filter(m => m.id !== props.selfId)
  return self ? [self, ...others] : others
})

const layout = computed(() => {
  const t = layoutTiles(people.value.length, size.w, size.h)
  // The route line under the name needs room too, so the face gives way.
  return props.showRoute && !t.row ? { ...t, avatar: 2 * Math.round(Math.max(32, Math.min(t.avatar, t.h - 78)) / 2) } : t
})

let observer: ResizeObserver | null = null
onMounted(() => {
  // The content box: what's left inside the padding that keeps clear of the call controls.
  observer = new ResizeObserver(([e]) => {
    size.w = Math.floor(e.contentRect.width)
    size.h = Math.floor(e.contentRect.height)
  })
  observer.observe(root.value!)
})
onBeforeUnmount(() => observer?.disconnect())

const isSelf = (id: string) => id === props.selfId
const mutedOf = (m: Member) => (isSelf(m.id) ? props.selfMuted || props.selfDeafened : m.muted)
const deafenedOf = (m: Member) => (isSelf(m.id) ? props.selfDeafened : m.deafened)
const speakingOf = (m: Member) => props.speaking.has(m.id) && !mutedOf(m) && !props.silenced[m.id]
function moodOf(m: Member): 'idle' | 'talking' | 'deafened' | 'away' {
  if (m.away) return 'away'
  if (deafenedOf(m)) return 'deafened'
  return speakingOf(m) ? 'talking' : 'idle'
}

function onMenu(id: string, e: MouseEvent) {
  if (isSelf(id)) return
  e.preventDefault()
  emit('menu', id, e.clientX, e.clientY)
}
// On a touch screen there's no right-click (and iOS has no long-press menu): a tap does it.
function onTap(id: string, e: MouseEvent) {
  if (touchFirst) onMenu(id, e)
}

function pingOf(id: string): number | null {
  const ms = props.showPing && !isSelf(id) ? props.links[id]?.rttMs : null
  return ms == null ? null : Math.round(ms)
}

function mouthToEar(s: LinkStats): string {
  if (s.measuredMs != null) return `${Math.round(s.measuredMs)} ms mouth to ear`
  if (s.mouthToEarMs != null) return `≈ ${Math.round(s.mouthToEarMs)} ms mouth to ear`
  return ''
}
</script>

<template>
  <div ref="root" class="grid" :class="{ scroll: layout.scroll, route: showRoute }" :style="{ '--gap': TILE_GAP + 'px' }">
    <div
      v-for="m in people"
      :key="m.id"
      class="seat tile"
      :class="{ self: isSelf(m.id), speaking: speakingOf(m), away: m.away, silenced: silenced[m.id], row: layout.row }"
      :style="{ width: layout.w + 'px', height: layout.h + 'px' }"
      :data-member="m.id"
      @contextmenu="onMenu(m.id, $event)"
      @click="onTap(m.id, $event)"
    >
      <span v-if="!layout.row && pingOf(m.id) != null" class="ping corner" :class="pingLevel(pingOf(m.id)!)">{{ pingOf(m.id) }} ms</span>
      <div class="face">
        <Avatar :name="m.name" :size="layout.avatar" :mood="moodOf(m)" />
      </div>
      <div class="info">
        <div class="tag">
          <span class="name">{{ m.name }}</span>
          <span v-if="m.away" class="sub">reconnecting…</span>
          <Icon v-if="mutedOf(m)" name="mic" :size="16" slash class="state" />
          <Icon v-if="deafenedOf(m)" name="headphones" :size="16" slash class="state" />
          <Icon v-if="silenced[m.id]" name="speaker" :size="16" slash class="state" />
        </div>
        <span v-if="layout.row && pingOf(m.id) != null" class="ping" :class="pingLevel(pingOf(m.id)!)">{{ pingOf(m.id) }} ms</span>
        <div v-if="showRoute && !isSelf(m.id)" class="route">
          <template v-if="links[m.id]">
            <span class="engine" :class="links[m.id].engine">{{ links[m.id].engine === 'll' ? 'Low latency' : 'WebRTC' }}</span>
            · {{ routeLabel(links[m.id]) }}<template v-if="mouthToEar(links[m.id])"> · {{ mouthToEar(links[m.id]) }}</template>
          </template>
          <template v-else>Connecting…</template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid {
  position: absolute;
  inset: 0;
  /* Clear of the call controls (and a phone's home bar) at the bottom. */
  padding: 12px 8px calc(100px + env(safe-area-inset-bottom));
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-content: center;
  gap: var(--gap);
  overflow: hidden;
}
.grid.scroll {
  align-content: flex-start;
  overflow-y: auto;
}

.tile {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-secondary);
  /* Flat: the speaking ring is a hard 2px line inside the edge. */
  box-shadow: inset 0 0 0 1px var(--border-subtle);
  transition: box-shadow 0.08s ease;
  overflow: hidden;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.tile:not(.self) {
  cursor: pointer;
}
.tile.speaking {
  box-shadow: inset 0 0 0 2px var(--green);
}
.tile.away .face {
  opacity: 0.45;
}
.face {
  border-radius: 50%;
  line-height: 0;
}

/* A tile: the face in the middle, the name along the bottom. */
.info {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}
.tile:not(.row) .face {
  margin-bottom: 18px;
}
.grid.route .tile:not(.row) .face {
  margin-bottom: 40px;
}

/* A row: the face on the left, the name beside it. */
.tile.row {
  flex-direction: row;
  justify-content: flex-start;
  gap: 12px;
  padding: 0 12px;
}
.tile.row .info {
  position: static;
  flex: 1;
}
.tile.row .tag {
  background: none;
  padding: 0;
}

.tag {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--bg-floating);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
}
.self:not(.row) .tag {
  background: rgba(88, 101, 242, 0.85);
}
.self.row .name {
  color: var(--brand-soft);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.sub {
  color: var(--text-muted);
  font-size: 12px;
}
.state {
  flex: none;
  color: var(--interactive-normal);
}
/* The name comes first: the ping goes in a tile's corner, or under the name in a row. */
.ping.corner {
  position: absolute;
  top: 8px;
  right: 8px;
  background: var(--bg-floating);
}
.ping {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  background: rgba(255, 255, 255, 0.08);
}
.ping.good {
  color: #3ba55c;
}
.ping.ok {
  color: var(--yellow);
}
.ping.bad {
  color: var(--red);
}
.route {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.engine {
  font-weight: 700;
  color: var(--text-normal);
}
.engine.ll {
  color: var(--brand-soft);
}
</style>
