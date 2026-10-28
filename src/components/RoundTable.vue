<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { Table, seatOffset, tableRadius } from '../lib/seats'
import { SEAT_SPRING, isSettled, settle, spring, stepSpring } from '../lib/spring'
import type { Member } from '../net/protocol'
import { pingLevel, routeLabel, type LinkStats } from '../net/stats'
import Avatar from './Avatar.vue'
import Icon from './Icon.vue'

/**
 * The round table. You're always at the bottom; everyone else is spread
 * evenly around it. Seats are moved by springs in JavaScript (not CSS
 * transitions) so their angles are known every frame, which is what the
 * spatial audio reads (the `angle` event).
 */

const props = defineProps<{
  members: Member[]
  selfId: string
  speaking: Set<string>
  /** Your own state, straight from the controls rather than waiting on the roster round trip. */
  selfMuted: boolean
  selfDeafened: boolean
  code: string
  silenced: Record<string, boolean>
  links: Record<string, LinkStats>
  showPing: boolean
  showRoute: boolean
}>()

const emit = defineEmits<{
  angle: [id: string, angle: number]
  menu: [id: string, x: number, y: number]
}>()

const root = ref<HTMLElement>()
const size = reactive({ w: 0, h: 0 })
const table = new Table()
/** Seats on screen, people fading out included. */
const seatIds = shallowRef<string[]>([])
/** The last we knew of everyone, so someone fading out still has a name. */
const known = new Map<string, Member>()
const seatEls = new Map<string, HTMLElement>()
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const geometry = computed(() => {
  const { w, h } = size
  // Even, so its centre lands on a whole pixel.
  const avatar = 2 * Math.round(Math.max(56, Math.min(92, Math.min(w, h) * 0.1)) / 2)
  // Name tag, plus the route card under it when that's on.
  const label = props.showRoute ? 160 : 34
  // Room for the floating call controls along the bottom.
  const bottom = 108
  const top = 20
  const ringV = (h - bottom - top - avatar - label) / 2
  const ringH = w / 2 - avatar * 1.4 - 24
  const ring = Math.max(110, Math.min(360, ringV, ringH))
  const block = 2 * ring + avatar + label
  const cx = w / 2
  const cy = top + Math.max(0, (h - bottom - top - block) / 2) + avatar / 2 + ring
  return { avatar, ring, cx, cy }
})

/**
 * How far out the seats are right now. The table grows with the number of
 * people (half size for 1–3, full size from 8), on a spring like everything
 * else so the seats ease outward as people sit down.
 */
const radius = spring(0)
const tableEl = ref<HTMLElement>()

function presentCount(): number {
  let n = 0
  for (const seat of table.seats.values()) if (!seat.leaving) n++
  return n
}

function retargetRadius(snap: boolean) {
  const g = geometry.value
  // Route cards are big: with them showing, the table stays full size so they have room.
  radius.target = props.showRoute ? g.ring : tableRadius(presentCount(), g.ring, g.avatar)
  if (snap || radius.x === 0) settle(radius)
}

const byId = computed(() => {
  const map = new Map<string, Member>()
  for (const m of props.members) {
    map.set(m.id, m)
    known.set(m.id, m)
  }
  return map
})

function member(id: string): Member | undefined {
  return byId.value.get(id) ?? known.get(id)
}

function refreshSeats() {
  // You last, so you're drawn on top of anyone sliding past the bottom.
  const ids = [...table.seats.keys()].filter(id => id !== props.selfId)
  if (table.seats.has(props.selfId)) ids.push(props.selfId)
  seatIds.value = ids
  for (const id of known.keys()) if (!table.seats.has(id)) known.delete(id)
}

function setSeatEl(id: string) {
  return (el: unknown) => {
    if (el instanceof HTMLElement) {
      seatEls.set(id, el)
      paintSeat(id)
    } else seatEls.delete(id)
  }
}

let raf = 0
let last = 0

function kick() {
  if (raf) return
  last = performance.now()
  raf = requestAnimationFrame(frame)
}

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  let moving: boolean
  if (reducedMotion) {
    table.finish()
    moving = false
  } else moving = table.step(dt)
  if (reducedMotion) settle(radius)
  else {
    stepSpring(radius, dt, SEAT_SPRING)
    if (isSettled(radius, 0.05)) settle(radius)
    else moving = true
  }
  if (table.seats.size !== seatIds.value.length) {
    refreshSeats()
    retargetRadius(false)
  }
  paint()
  raf = moving ? requestAnimationFrame(frame) : 0
}

function paintSeat(id: string) {
  const seat = table.seats.get(id)
  const el = seatEls.get(id)
  if (!seat || !el) return
  const g = geometry.value
  const { x, y } = seatOffset(seat.angle.x, radius.x)
  const p = Math.max(0, Math.min(1, seat.presence.x))
  const left = g.cx + x - g.avatar / 2
  const top = g.cy + y - g.avatar / 2
  // At rest: whole pixels and no scale, so the face and name are drawn
  // crisp rather than resampled. Only while moving is it fractional.
  const still = seat.angle.v === 0 && seat.presence.v === 0 && p === 1 && radius.v === 0
  el.style.transform = still
    ? `translate(${Math.round(left)}px, ${Math.round(top)}px)`
    : `translate(${left.toFixed(2)}px, ${top.toFixed(2)}px) scale(${(0.55 + 0.45 * p).toFixed(4)})`
  el.style.opacity = p === 1 ? '' : p.toFixed(3)
}

function paintTable() {
  const el = tableEl.value
  if (!el) return
  const g = geometry.value
  const still = radius.v === 0
  const r = Math.max(0, radius.x - g.avatar * 0.22)
  const d = still ? 2 * Math.round(r) : 2 * r
  const left = g.cx - d / 2
  const top = g.cy - d / 2
  el.style.width = el.style.height = d.toFixed(2) + 'px'
  el.style.transform = still ? `translate(${Math.round(left)}px, ${Math.round(top)}px)` : `translate(${left.toFixed(2)}px, ${top.toFixed(2)}px)`
}

function paint() {
  paintTable()
  for (const seat of table.seats.values()) {
    paintSeat(seat.id)
    if (seat.id !== props.selfId) emit('angle', seat.id, seat.angle.x)
  }
}

watch(
  () => [props.selfId, ...props.members.map(m => m.id)].join(','),
  () => {
    if (!props.selfId) return
    const ids = props.members.map(m => m.id)
    if (!ids.includes(props.selfId)) ids.unshift(props.selfId)
    table.sync(ids, props.selfId)
    refreshSeats()
    retargetRadius(false)
    void nextTick(paint)
    kick()
  },
  { immediate: true }
)

// A resized window jumps straight to the new size; only people joining and leaving animate.
watch(
  () => props.showRoute,
  () => {
    retargetRadius(false)
    kick()
  }
)

watch(geometry, () => {
  retargetRadius(true)
  paint()
})

let observer: ResizeObserver | null = null
onMounted(() => {
  const el = root.value!
  const measure = () => {
    size.w = el.clientWidth
    size.h = el.clientHeight
  }
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(el)
  void nextTick(paint)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (raf) cancelAnimationFrame(raf)
})

function isSelf(id: string) {
  return id === props.selfId
}
function mutedOf(id: string) {
  return isSelf(id) ? props.selfMuted || props.selfDeafened : !!member(id)?.muted
}
function deafenedOf(id: string) {
  return isSelf(id) ? props.selfDeafened : !!member(id)?.deafened
}
function speakingOf(id: string) {
  return props.speaking.has(id) && !mutedOf(id) && !props.silenced[id]
}

function moodOf(id: string): 'idle' | 'talking' | 'deafened' | 'away' {
  if (member(id)?.away) return 'away'
  if (deafenedOf(id)) return 'deafened'
  return speakingOf(id) ? 'talking' : 'idle'
}

function n0(ms: number | null): string {
  return ms == null ? '?' : String(Math.round(ms))
}

function breakdownTitle(s: LinkStats): string {
  return [
    `Microphone: ${n0(s.captureMs)} ms (yours, as your browser reports it)`,
    `Codec: ${n0(s.codecMs)} ms (10 ms Opus frame + lookahead)`,
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


const count = computed(() => props.members.filter(m => !m.away).length || 1)
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
        away: member(id)?.away,
        silenced: silenced[id]
      }"
      :style="{ '--avatar': geometry.avatar + 'px' }"
      :data-member="id"
      @contextmenu="onMenu(id, $event)"
    >
      <div class="ring">
        <Avatar
          :name="member(id)?.name ?? ''"
          :size="geometry.avatar"
          :mood="moodOf(id)"
        />
      </div>
      <div class="under">
        <div class="tag">
          <span class="name">{{ member(id)?.name }}</span>
          <span v-if="member(id)?.away" class="sub">reconnecting…</span>
          <Icon v-if="mutedOf(id)" name="mic" :size="16" slash class="state" />
          <Icon v-if="deafenedOf(id)" name="headphones" :size="16" slash class="state" />
          <Icon v-if="silenced[id]" name="speaker" :size="16" slash class="state" />
          <span
            v-if="showPing && !isSelf(id) && links[id]?.rttMs != null"
            class="ping"
            :class="pingLevel(links[id].rttMs!)"
            :title="routeLabel(links[id])"
          >
            {{ Math.round(links[id].rttMs!) }} ms
          </span>
        </div>
        <div v-if="showRoute && !isSelf(id)" class="route">
          <template v-if="links[id]">
            <div class="engine" :class="links[id].engine">
              {{ links[id].engine === 'll' ? 'Low-latency engine' : 'WebRTC audio' }}
            </div>
            <div class="route-head" :class="links[id].route ?? ''">
              <span class="dot" />
              {{ routeLabel(links[id]) }}
            </div>
            <div class="route-line">
              {{ [links[id].protocol?.toUpperCase(), links[id].relayProtocol ? `${links[id].relayProtocol!.toUpperCase()} to relay` : '', links[id].codec, links[id].kbps == null ? '' : `${Math.round(links[id].kbps!)} kbps`]
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
              mic {{ n0(links[id].captureMs) }} · codec {{ n0(links[id].codecMs) }} · net {{ n0(links[id].rttMs! / 2) }} · buffer
              {{ n0(links[id].bufferMs) }} · out {{ n0(links[id].playoutMs) }}
            </div>
            <div v-if="links[id].ll" class="route-line dim">
              target {{ n0(links[id].ll!.targetMs) }} ms · late {{ links[id].ll!.late }} · concealed
              {{ links[id].ll!.concealedPct.toFixed(1) }}%
            </div>
            <div class="route-line dim">
              jitter {{ fmt(links[id].jitterMs) }} · {{ links[id].ll ? 'gaps' : 'loss' }}
              {{ links[id].lossPct == null ? '–' : links[id].lossPct!.toFixed(links[id].lossPct! < 1 ? 1 : 0) + '%' }}
            </div>
          </template>
          <div v-else class="route-head">Connecting…</div>
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
.engine {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.engine.ll {
  color: var(--brand-soft);
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
</style>
