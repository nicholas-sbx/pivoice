<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { layoutTiles, tileSpacing } from '../lib/tiles'
import { touchFirst } from '../lib/viewport'
import type { Member } from '../net/protocol'
import { pingLevel, routeLabel, type LinkStats } from '../net/stats'
import type { CaptionView } from '../captions/board'
import Avatar from './Avatar.vue'
import CaptionText from './CaptionText.vue'
import Icon from './Icon.vue'
import { vSnap } from '../lib/snap'

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
  /** Making any sound at all: a thin edge, under the full one for speaking. */
  audible: Set<string>
  selfMuted: boolean
  selfDeafened: boolean
  silenced: Record<string, boolean>
  links: Record<string, LinkStats>
  showPing: boolean
  showRoute: boolean
  /** Live captions: who's saying what, and how they're shown (`showCaptions`: other people's). */
  captions?: Record<string, CaptionView>
  captionLines?: number
  captionFade?: number
  captionCaret?: boolean
  captionScale?: number
  showCaptions?: boolean
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

const spacing = computed(() => tileSpacing(people.value.length))
const layout = computed(() => {
  const t = layoutTiles(people.value.length, size.w, size.h, spacing.value.gap)
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
const audibleOf = (m: Member) => props.audible.has(m.id) && !mutedOf(m) && !props.silenced[m.id]
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

function captionOf(m: Member): CaptionView | null {
  // Yours are only here if you asked to see them; everyone else's only if you show captions.
  if ((!isSelf(m.id) && !props.showCaptions) || props.silenced[m.id] || mutedOf(m)) return null
  return props.captions?.[m.id] ?? null
}

/** A caret after their words while they're still speaking: more may be coming. */
function caretOf(m: Member): boolean {
  if (props.captionCaret === false) return false
  const v = captionOf(m)
  return !!v && (v.live || speakingOf(m))
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
  <div ref="root" class="grid" :class="{ scroll: layout.scroll, route: showRoute }" :style="{ '--gap': spacing.gap + 'px', '--edge': spacing.edge + 'px' }">
    <div
      v-for="m in people"
      :key="m.id"
      v-snap
      class="seat tile"
      :class="{ self: isSelf(m.id), speaking: speakingOf(m), audible: audibleOf(m) && !speakingOf(m), away: m.away, silenced: silenced[m.id], row: layout.row }"
      :style="{ width: layout.w + 'px', height: layout.h + 'px' }"
      :data-member="m.id"
      @contextmenu="onMenu(m.id, $event)"
      @click="onTap(m.id, $event)"
    >
      <span v-if="!layout.row && pingOf(m.id) != null" class="ping corner" :class="pingLevel(pingOf(m.id)!)">{{ pingOf(m.id) }} ms</span>
      <div class="face">
        <Avatar :name="m.name" :size="layout.avatar" :mood="moodOf(m)" />
      </div>
      <!-- A tile: over the lower part of it, above the name. A row: beside the face, under the name (one line). -->
      <div v-if="captionOf(m) && !layout.row" class="cap">
        <CaptionText :view="captionOf(m)!" :lines="captionLines ?? 3" :fade="captionFade ?? 0.25" :caret="caretOf(m)" :scale="captionScale ?? 1" />
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
        <div v-if="captionOf(m) && layout.row" class="cap-row">
          <CaptionText :view="captionOf(m)!" :lines="1" :fade="captionFade ?? 0.25" :caret="caretOf(m)" :scale="Math.min(1, captionScale ?? 1)" />
        </div>
        <div v-if="showRoute && !isSelf(m.id)" class="route">
          <template v-if="links[m.id]">
            {{ routeLabel(links[m.id]) }}<template v-if="mouthToEar(links[m.id])"> · {{ mouthToEar(links[m.id]) }}</template>
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
  /* The edge room shrinks as people join (lib/tiles); the content box it leaves is what the tiles are sized to. */
  padding: var(--edge) calc(var(--edge) + env(safe-area-inset-right)) calc(100px + env(safe-area-inset-bottom))
    calc(var(--edge) + env(safe-area-inset-left));
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
/* Something's coming through, but not speech: a thin green edge. */
.tile.audible {
  box-shadow: inset 0 0 0 1px var(--green);
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
.cap {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 38px;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.grid.route .cap {
  bottom: 60px;
}
.cap-row {
  max-width: 100%;
  min-width: 0;
}
.cap-row :deep(.caption) {
  padding: 1px 6px;
  font-size: calc(12px * var(--scale));
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
</style>
