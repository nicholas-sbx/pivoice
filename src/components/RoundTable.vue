<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { seating } from '../call'
import { TAU, tableRadius } from '../lib/seats'
import { useSeatStates, useTableView } from '../lib/tableView'
import type { Member } from '../net/protocol'
import { pingLevel, routeLabel, type LinkStats } from '../net/stats'
import { vSnap } from '../lib/snap'
import { touchFirst } from '../lib/viewport'
import type { CaptionView } from '../captions/board'
import Avatar from './Avatar.vue'
import CaptionText from './CaptionText.vue'
import Icon from './Icon.vue'

/**
 * The round table. You're always at the bottom; everyone else is spread
 * evenly around it. Where each seat is comes from the call's shared seating
 * (lib/seating), which moves them with springs in JavaScript (not CSS
 * transitions) and is what the spatial audio reads; this draws them.
 */

const props = defineProps<{
  members: Member[]
  selfId: string
  speaking: Set<string>
  /** Making any sound at all: a thin ring, under the full one for speaking. */
  audible: Set<string>
  /** Your own state, straight from the controls rather than waiting on the roster round trip. */
  selfMuted: boolean
  selfDeafened: boolean
  code: string
  silenced: Record<string, boolean>
  links: Record<string, LinkStats>
  showPing: boolean
  showRoute: boolean
  /** Live captions: who's saying what, and how they're shown (`showCaptions`: other people's). */
  captions?: Record<string, CaptionView>
  captionLines?: number
  captionScale?: number
  showCaptions?: boolean
}>()

const emit = defineEmits<{
  menu: [id: string, x: number, y: number]
}>()

const root = ref<HTMLElement>()
const tableEl = ref<HTMLElement>()

const { size, geometry, member, retarget, setSeatEl, seatIds } = useTableView({
  seating,
  root,
  tableEl,
  members: () => props.members,
  selfId: () => props.selfId,
  geometry(w, h) {
    // A phone: smaller seats, and the ring as wide as the screen allows (name tags may reach past it).
    const small = w < 640
    // Even, so its centre lands on a whole pixel.
    const avatar = 2 * Math.round(Math.max(small ? 40 : 56, Math.min(92, Math.min(w, h) * 0.1)) / 2)
    // Name tag, plus the route card under it when that's on.
    const label = props.showRoute ? 160 : 34
    // Room for the floating call controls along the bottom.
    const bottom = 108
    const top = 20
    const ringV = (h - bottom - top - avatar - label) / 2
    const ringH = small ? w / 2 - avatar * 0.75 - 12 : w / 2 - avatar * 1.4 - 24
    const ring = Math.max(small ? 90 : 110, Math.min(360, ringV, ringH))
    const block = 2 * ring + avatar + label
    const cx = w / 2
    const cy = top + Math.max(0, (h - bottom - top - block) / 2) + avatar / 2 + ring
    return { avatar, ring, cx, cy }
  },
  // The table grows with the number of people (half size for 1–3, full size from 8).
  // Route cards are big: with them showing, the table stays full size so they have room.
  radius: (g, present) => (props.showRoute ? g.ring : tableRadius(present, g.ring, g.avatar))
})

watch(
  () => props.showRoute,
  () => {
    retarget(false)
    seating.kick()
  }
)

const { isSelf, mutedOf, deafenedOf, speakingOf, audibleOf, moodOf } = useSeatStates(props, member)

function n0(ms: number | null): string {
  return ms == null ? '?' : String(Math.round(ms))
}

function breakdownTitle(s: LinkStats): string {
  return [
    `Microphone: ${n0(s.captureMs)} ms (yours, as your browser reports it)`,
    `Sending: ${n0(s.sendMs)} ms (one 128-sample block)`,
    `Network: ${n0(s.rttMs == null ? null : s.rttMs / 2)} ms (half the round trip)`,
    `Jitter buffer: ${n0(s.bufferMs)} ms`,
    `Playout: ${n0(s.playoutMs)} ms (browser to speakers)`,
    '? = not reported by this browser, counted as 0.'
  ].join('\n')
}

function fmt(ms: number | null): string {
  return ms == null ? '–' : `${Math.round(ms)} ms`
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


const count = computed(() => props.members.filter(m => !m.away).length || 1)

/**
 * Captions go on the side of each face toward the middle of the table, so
 * they're over the felt rather than off the edge of the screen: above you
 * (and anyone near the bottom), below those across the table, beside
 * those at the sides. By where they're heading, so a caption doesn't flip
 * sides mid-slide.
 */
type Side = 'above' | 'below' | 'left' | 'right'
const sides = computed(() => {
  void seating.revision.value
  const out = new Map<string, Side>()
  for (const s of seating.targets()) {
    const a = ((s.angle % TAU) + TAU) % TAU
    out.set(s.id, a < Math.PI / 4 || a > (7 * Math.PI) / 4 ? 'above' : a < (3 * Math.PI) / 4 ? 'right' : a <= (5 * Math.PI) / 4 ? 'below' : 'left')
  }
  return out
})
const sideOf = (id: string): Side => (isSelf(id) ? 'above' : (sides.value.get(id) ?? 'below'))
function captionOf(id: string): CaptionView | null {
  // Yours are only here if you asked to see them; everyone else's only if you show captions.
  if ((!isSelf(id) && !props.showCaptions) || props.silenced[id] || mutedOf(id)) return null
  return props.captions?.[id] ?? null
}
</script>

<template>
  <div ref="root" class="stage">
    <div ref="tableEl" class="table">
      <div class="felt">
        <div v-if="code" class="code">{{ code }}</div>
        <div class="count">{{ count }} {{ count === 1 ? 'person' : 'people' }} at the table</div>
      </div>
    </div>

    <div
      v-for="id in seatIds"
      :key="id"
      :ref="setSeatEl(id)"
      class="seat"
      :class="{
        self: isSelf(id),
        speaking: speakingOf(id),
        audible: audibleOf(id) && !speakingOf(id),
        away: member(id)?.away,
        silenced: silenced[id]
      }"
      :style="{ '--avatar': geometry.avatar + 'px' }"
      :data-small="size.w < 640 ? '' : undefined"
      :data-member="id"
      @contextmenu="onMenu(id, $event)"
      @click="onTap(id, $event)"
    >
      <div class="ring">
        <Avatar
          :name="member(id)?.name ?? ''"
          :size="geometry.avatar"
          :mood="moodOf(id)"
        />
      </div>
      <div v-if="captionOf(id) && sideOf(id) !== 'below'" class="cap" :class="sideOf(id)">
        <CaptionText :view="captionOf(id)!" :lines="captionLines ?? 2" :scale="captionScale ?? 1" />
      </div>
      <div class="under">
        <div v-snap class="tag">
          <span class="name">{{ member(id)?.name }}</span>
          <span v-if="member(id)?.away" class="sub">reconnecting…</span>
          <Icon v-if="mutedOf(id)" name="mic" :size="16" slash class="state" />
          <Icon v-if="deafenedOf(id)" name="headphones" :size="16" slash class="state" />
          <Icon v-if="silenced[id]" name="speaker" :size="16" slash class="state" />
          <span
            v-if="showPing && !isSelf(id) && links[id]?.rttMs != null"
            class="ping"
            :class="pingLevel(links[id].rttMs!)"
            :title="links[id].route ? routeLabel(links[id]) : undefined"
          >
            {{ Math.round(links[id].rttMs!) }} ms
          </span>
        </div>
        <div v-if="showRoute && !isSelf(id)" class="route">
          <template v-if="links[id]">
            <div class="route-head" :class="links[id].route ?? ''">
              <span class="dot" />
              {{ routeLabel(links[id]) }}
            </div>
            <div class="route-line">
              {{ [links[id].protocol?.toUpperCase(), links[id].relayProtocol ? `${links[id].relayProtocol!.toUpperCase()} to relay` : '', links[id].kbps == null ? '' : `${Math.round(links[id].kbps!)} kbps`]
                .filter(Boolean)
                .join(' · ') }}
            </div>
            <div
              v-if="links[id].measuredMs != null"
              class="route-line big"
              title="Measured: their capture time (stamped on the audio) to when it reached your speakers. Exact on one machine; across machines it's as good as your two clocks."
            >
              {{ Math.round(links[id].measuredMs!) }} ms mouth to ear
            </div>
            <div v-else-if="links[id].mouthToEarMs != null" class="route-line big" :title="breakdownTitle(links[id])">
              ≈ {{ Math.round(links[id].mouthToEarMs!) }} ms mouth to ear
            </div>
            <div v-if="links[id].mouthToEarMs != null" class="route-line dim wrap">
              mic {{ n0(links[id].captureMs) }} · send {{ n0(links[id].sendMs) }} · net {{ n0(links[id].rttMs! / 2) }} · buffer
              {{ n0(links[id].bufferMs) }} · out {{ n0(links[id].playoutMs) }}
            </div>
            <div v-if="links[id].ll" class="route-line dim">
              target {{ n0(links[id].ll!.targetMs) }} ms · late {{ links[id].ll!.late }} · concealed
              {{ links[id].ll!.concealedPct.toFixed(1) }}%
            </div>
            <div class="route-line dim">
              jitter {{ fmt(links[id].jitterMs) }} · gaps
              {{ links[id].lossPct == null ? '–' : links[id].lossPct!.toFixed(links[id].lossPct! < 1 ? 1 : 0) + '%' }}
            </div>
          </template>
          <div v-else class="route-head">Connecting…</div>
        </div>
        <div v-if="captionOf(id) && sideOf(id) === 'below'" class="cap-below">
          <CaptionText :view="captionOf(id)!" :lines="captionLines ?? 2" :scale="captionScale ?? 1" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.table {
  position: absolute;
  left: 0;
  top: 0;
  border-radius: 50%;
  /* Seen from straight above: a flat disc with a hard edge. */
  background: var(--bg-secondary);
  border: 1px solid var(--border-strong);
}
.felt {
  position: absolute;
  inset: 14%;
  border-radius: 50%;
  border: 1px solid #35373c;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
  user-select: none;
}
.code {
  font-family: var(--font-code);
  font-size: clamp(18px, 3vw, 28px);
  font-weight: 600;
  letter-spacing: 0.24em;
  margin-right: -0.24em;
  color: rgba(242, 243, 245, 0.16);
}
.count {
  font-size: 13px;
  font-weight: 500;
  color: rgba(181, 186, 193, 0.4);
}

.seat {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--avatar);
  height: var(--avatar);
  cursor: default;
}
.seat:not(.self) {
  cursor: context-menu;
}
.ring {
  border-radius: 50%;
  box-shadow: 0 0 0 3px var(--bg-stage);
  transition: box-shadow 0.08s ease;
}
/* Something's coming through, but not speech: a thin line where the ring goes. */
.seat.audible .ring {
  box-shadow:
    0 0 0 3px var(--bg-stage),
    0 0 0 4px var(--green);
}
.seat.speaking .ring {
  box-shadow:
    0 0 0 3px var(--bg-stage),
    0 0 0 6px var(--green);
}
.seat.away .ring {
  opacity: 0.45;
}
.under {
  /* Centred by layout, not by a -50% transform, so text sits on whole pixels. */
  position: absolute;
  top: 100%;
  left: -150px;
  right: -150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}
.tag {
  margin-top: 8px;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 200px;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--bg-floating);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.seat[data-small] .tag {
  max-width: 130px;
  padding: 2px 6px;
  font-size: 12px;
  line-height: 16px;
}
.seat[data-small] .ping {
  font-size: 11px;
  padding: 0 4px;
}
.sub {
  color: var(--text-muted);
  font-size: 12px;
}
.state {
  color: var(--interactive-normal);
}
.ping {
  margin-left: 2px;
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
  margin-top: 6px;
  z-index: 1;
  width: 236px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--bg-floating);
  border: 1px solid var(--border-strong);
  font-size: 12px;
  line-height: 16px;
  color: var(--text-normal);
  text-align: center;
  white-space: nowrap;
  pointer-events: none;
}
.route-head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-weight: 600;
  color: var(--header-primary);
  overflow: hidden;
  text-overflow: ellipsis;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  flex: none;
}
.route-head.local .dot,
.route-head.direct .dot {
  background: var(--green);
}
.route-head.relay .dot {
  background: var(--yellow);
}
.route-line {
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.route-line:empty {
  display: none;
}
.wrap {
  white-space: normal;
}
.big {
  font-weight: 600;
  color: var(--header-primary);
}
.dim {
  color: var(--text-muted);
}
.self .tag {
  background: rgba(88, 101, 242, 0.85);
}

/* Captions, toward the middle of the table (no -50% transforms: text stays on whole pixels). */
.cap {
  position: absolute;
  z-index: 2;
  display: flex;
  pointer-events: none;
}
.cap :deep(.caption) {
  max-width: min(260px, 38vw);
}
.cap.above {
  bottom: calc(100% + 12px);
  left: -150px;
  right: -150px;
  justify-content: center;
}
.cap.right,
.cap.left {
  top: 0;
  bottom: 0;
  width: min(260px, 38vw);
  align-items: center;
}
.cap.right {
  left: calc(100% + 14px);
}
.cap.left {
  right: calc(100% + 14px);
  justify-content: flex-end;
}
.cap-below {
  margin-top: 8px;
  z-index: 2;
  max-width: min(260px, 60vw);
}
.seat[data-small] .cap :deep(.caption),
.seat[data-small] .cap-below :deep(.caption) {
  max-width: min(180px, 42vw);
  font-size: calc(12px * var(--scale));
}
.seat[data-small] .cap.right,
.seat[data-small] .cap.left {
  width: min(180px, 42vw);
}
</style>
