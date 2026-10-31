<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { seating } from '../call'
import { tableRadius } from '../lib/seats'
import { useSeatStates, useTableView } from '../lib/tableView'
import type { Member } from '../net/protocol'
import { t } from '../i18n'
import { pingLevel, routeLabel, type LinkStats } from '../net/stats'
import { vSnap } from '../lib/snap'
import { touchFirst } from '../lib/viewport'
import Avatar from './Avatar.vue'
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
    t('route.breakdown.mic', { ms: n0(s.captureMs) }),
    t('route.breakdown.codec', { ms: n0(s.codecMs) }),
    t('route.breakdown.network', { ms: n0(s.rttMs == null ? null : s.rttMs / 2) }),
    t('route.breakdown.buffer', { ms: n0(s.bufferMs) }),
    t('route.breakdown.playout', { ms: n0(s.playoutMs) }),
    t('route.breakdown.unknown')
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
</script>

<template>
  <div ref="root" class="stage">
    <div ref="tableEl" class="table">
      <div class="felt">
        <div v-if="code" class="code">{{ code }}</div>
        <div class="count">{{ t('table.count', { count }) }}</div>
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
      <div class="under">
        <div v-snap class="tag">
          <span class="name">{{ member(id)?.name }}</span>
          <span v-if="member(id)?.away" class="sub">{{ t('table.reconnecting') }}</span>
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
            <div class="engine" :class="links[id].engine">
              {{ links[id].engine === 'll' ? t('route.engineLLLong') : t('route.engineWebRTCLong') }}
            </div>
            <div class="route-head" :class="links[id].route ?? ''">
              <span class="dot" />
              {{ routeLabel(links[id]) }}
            </div>
            <div class="route-line">
              {{ [links[id].protocol?.toUpperCase(), links[id].relayProtocol ? t('route.toRelay', { protocol: links[id].relayProtocol!.toUpperCase() }) : '', links[id].codec, links[id].kbps == null ? '' : `${Math.round(links[id].kbps!)} kbps`]
                .filter(Boolean)
                .join(' · ') }}
            </div>
            <div
              v-if="links[id].measuredMs != null"
              class="route-line big"
              :title="t('route.measuredTitle')"
            >
              {{ t('route.mouthToEar', { ms: Math.round(links[id].measuredMs!) }) }}
            </div>
            <div v-else-if="links[id].mouthToEarMs != null" class="route-line big" :title="breakdownTitle(links[id])">
              {{ t('route.mouthToEarApprox', { ms: Math.round(links[id].mouthToEarMs!) }) }}
            </div>
            <div v-if="links[id].mouthToEarMs != null" class="route-line dim wrap">
              {{
                t('route.parts', {
                  mic: n0(links[id].captureMs),
                  codec: n0(links[id].codecMs),
                  net: n0(links[id].rttMs! / 2),
                  buffer: n0(links[id].bufferMs),
                  out: n0(links[id].playoutMs)
                })
              }}
            </div>
            <div v-if="links[id].ll" class="route-line dim">
              {{
                t('route.llStats', {
                  target: n0(links[id].ll!.targetMs),
                  late: links[id].ll!.late,
                  concealed: links[id].ll!.concealedPct.toFixed(1)
                })
              }}
            </div>
            <div class="route-line dim">
              {{
                t(links[id].ll ? 'route.jitterGaps' : 'route.jitterLoss', {
                  jitter: fmt(links[id].jitterMs),
                  loss: links[id].lossPct == null ? '–' : links[id].lossPct!.toFixed(links[id].lossPct! < 1 ? 1 : 0) + '%'
                })
              }}
            </div>
          </template>
          <div v-else class="route-head">{{ t('common.connecting') }}</div>
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
