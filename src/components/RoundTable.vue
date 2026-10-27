<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { Table, seatOffset } from '../lib/seats'
import type { Member } from '../net/protocol'
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
  const avatar = Math.round(Math.max(56, Math.min(92, Math.min(w, h) * 0.1)))
  const label = 34
  // Room for the floating call controls along the bottom.
  const bottom = 108
  const top = 20
  const ringV = (h - bottom - top - avatar - label) / 2
  const ringH = w / 2 - avatar * 1.4 - 24
  const ring = Math.max(110, Math.min(360, ringV, ringH))
  const block = 2 * ring + avatar + label
  const cx = w / 2
  const cy = top + Math.max(0, (h - bottom - top - block) / 2) + avatar / 2 + ring
  return { avatar, ring, cx, cy, table: ring - avatar * 0.22 }
})

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
/** Bumped whenever the seats come to rest. */
const settledTick = ref(0)

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
  if (table.seats.size !== seatIds.value.length) refreshSeats()
  paint()
  raf = moving ? requestAnimationFrame(frame) : 0
  if (!moving) settledTick.value++
}

function paintSeat(id: string) {
  const seat = table.seats.get(id)
  const el = seatEls.get(id)
  if (!seat || !el) return
  const g = geometry.value
  const { x, y } = seatOffset(seat.angle.x, g.ring)
  const p = Math.max(0, Math.min(1, seat.presence.x))
  el.style.transform = `translate3d(${(g.cx + x).toFixed(2)}px, ${(g.cy + y).toFixed(2)}px, 0) translate(-50%, -50%) scale(${(0.55 + 0.45 * p).toFixed(4)})`
  el.style.opacity = p.toFixed(3)
}

function paint() {
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
    void nextTick(paint)
    kick()
  },
  { immediate: true }
)

watch(geometry, () => paint())

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

/** Everyone looks at whoever's talking (the talker looks at whoever else is). */
function lookFor(id: string): Element | null {
  for (const other of props.speaking) {
    if (other !== id && speakingOf(other)) return seatEls.get(other) ?? null
  }
  return null
}

function onMenu(id: string, e: MouseEvent) {
  if (isSelf(id)) return
  e.preventDefault()
  emit('menu', id, e.clientX, e.clientY)
}

const tableStyle = computed(() => {
  const g = geometry.value
  return {
    width: g.table * 2 + 'px',
    height: g.table * 2 + 'px',
    left: g.cx - g.table + 'px',
    top: g.cy - g.table + 'px'
  }
})

const count = computed(() => props.members.filter(m => !m.away).length || 1)
</script>

<template>
  <div ref="root" class="stage">
    <div class="table" :style="tableStyle">
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
          :look="lookFor(id)"
          :layout="settledTick"
        />
      </div>
      <div class="tag">
        <span class="name">{{ member(id)?.name }}</span>
        <span v-if="member(id)?.away" class="sub">reconnecting…</span>
        <Icon v-if="mutedOf(id)" name="mic" :size="16" slash class="state" />
        <Icon v-if="deafenedOf(id)" name="headphones" :size="16" slash class="state" />
        <Icon v-if="silenced[id]" name="speaker" :size="16" slash class="state" />
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
  border-radius: 50%;
  /* Seen from straight above: a flat disc, lit from overhead, shadow all round. */
  background: radial-gradient(circle at 50% 50%, #3a3c42 0%, #2f3136 60%, #26282c 100%);
  box-shadow:
    0 0 70px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(255, 255, 255, 0.05),
    inset 0 0 0 6px rgba(0, 0, 0, 0.12),
    inset 0 0 50px rgba(0, 0, 0, 0.25);
}
.felt {
  position: absolute;
  inset: 14%;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.04);
  background: radial-gradient(circle at 50% 50%, rgba(88, 101, 242, 0.08), transparent 70%);
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
  opacity: 0;
  will-change: transform, opacity;
  cursor: default;
}
.seat:not(.self) {
  cursor: context-menu;
}
.ring {
  border-radius: 50%;
  box-shadow:
    0 0 0 3px var(--bg-stage),
    0 0 16px rgba(0, 0, 0, 0.5);
  transition: box-shadow 0.08s ease;
}
.seat.speaking .ring {
  box-shadow:
    0 0 0 3px var(--bg-stage),
    0 0 0 6px var(--green),
    0 0 16px rgba(0, 0, 0, 0.5);
}
.seat.away .ring {
  opacity: 0.45;
}
.tag {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 200px;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
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
.self .tag {
  background: rgba(88, 101, 242, 0.85);
}
</style>
