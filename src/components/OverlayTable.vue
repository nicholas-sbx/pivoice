<script setup lang="ts">
import { computed, ref } from 'vue'
import { tableRadius } from '../lib/seats'
import type { Seating } from '../lib/seating'
import { useSeatStates, useTableView } from '../lib/tableView'
import type { Member } from '../net/protocol'
import Avatar from './Avatar.vue'
import Icon from './Icon.vue'

/**
 * The table in miniature, for a small always-on-top window: the same seats
 * as the big one (from the call's shared seating), each face with its
 * speaking ring and the thin one for any sound, mute and deafen marks, and a
 * short name tag. Everything it needs is in its props, seats included, so
 * whatever draws it only has to hand it the call: the pop-out window gives it
 * the call's own seating, and the app's overlay (overlay/main.ts) a copy of
 * it, sent across.
 *
 * It can be shown in another window than the page's, so it asks the element
 * it's in for the window (lib/tableView does) and never uses the global one:
 * the page's own window is often hidden then, and its animation frames are
 * paused.
 */

const props = defineProps<{
  /** Who sits where (the call's, or the overlay's copy of it). */
  seating: Seating
  members: Member[]
  selfId: string
  speaking: Set<string>
  /** Making any sound at all: a thin ring, under the full one for speaking. */
  audible: Set<string>
  selfMuted: boolean
  selfDeafened: boolean
  silenced: Record<string, boolean>
  /** Mute, deafen, spatial audio and hang up, under the table. */
  controls?: boolean
  /**
   * Drawn straight onto the screen, over whatever you're doing (the app's
   * overlay): no background, and the table and anyone quiet faded back to
   * `dim` while whoever's speaking comes up in full.
   */
  bare?: boolean
  dim?: number
  /** How big the faces and names are, whatever the size of the space (1: as they'd be). */
  scale?: number
  spatial?: boolean
  spatialLabel?: string
}>()

defineEmits<{ toggleMute: []; toggleDeafen: []; toggleSpatial: []; leave: [] }>()

const root = ref<HTMLElement>()
const tableEl = ref<HTMLElement>()

const { geometry, member, setSeatEl, seatIds } = useTableView({
  seating: props.seating,
  root,
  tableEl,
  members: () => props.members,
  selfId: () => props.selfId,
  geometry(w, h) {
    const k = props.scale ?? 1
    // Even, so its centre lands on a whole pixel.
    const avatar = 2 * Math.round(Math.max(28 * k, Math.min(56 * k, Math.min(w, h) * 0.16 * k)) / 2)
    // A name tag under each face, and a little air round the edge.
    const label = Math.round(22 * k)
    const pad = 8
    const ringV = (h - 2 * pad - avatar - label) / 2
    // Name tags reach about this far out either side of a face.
    const ringH = w / 2 - Math.max(avatar / 2, 40 * k) - pad
    const ring = Math.max(40, Math.min(240, ringV, ringH))
    const block = 2 * ring + avatar + label
    const cx = w / 2
    const cy = pad + Math.max(0, (h - 2 * pad - block) / 2) + avatar / 2 + ring
    return { avatar, ring, cx, cy }
  },
  radius: (g, present) => tableRadius(present, g.ring, g.avatar)
})

const { isSelf, mutedOf, deafenedOf, speakingOf, audibleOf, moodOf } = useSeatStates(props, member)
const icon = computed(() => Math.round(12 * (props.scale ?? 1)))
</script>

<template>
  <div class="overlay" :class="{ bare }" :style="{ '--dim': dim ?? 1, '--k': scale ?? 1 }">
    <div ref="root" class="stage">
      <div ref="tableEl" class="table">
        <div class="felt" />
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
        :data-member="id"
      >
        <div class="ring">
          <Avatar :name="member(id)?.name ?? ''" :size="geometry.avatar" :mood="moodOf(id)" />
        </div>
        <div class="under">
          <div class="tag">
            <span class="name">{{ member(id)?.name }}</span>
            <Icon v-if="mutedOf(id)" name="mic" :size="icon" slash class="state" />
            <Icon v-if="deafenedOf(id)" name="headphones" :size="icon" slash class="state" />
            <Icon v-if="silenced[id]" name="speaker" :size="icon" slash class="state" />
          </div>
        </div>
      </div>
    </div>

    <div v-if="controls" class="controls" role="toolbar" aria-label="Call controls">
      <button
        type="button"
        class="btn"
        :class="{ off: selfMuted }"
        :title="selfMuted ? 'Unmute' : 'Mute'"
        :aria-label="selfMuted ? 'Unmute' : 'Mute'"
        :aria-pressed="selfMuted"
        @click="$emit('toggleMute')"
      >
        <Icon name="mic" :size="20" :slash="selfMuted" />
      </button>
      <button
        type="button"
        class="btn"
        :class="{ off: selfDeafened }"
        :title="selfDeafened ? 'Undeafen' : 'Deafen'"
        :aria-label="selfDeafened ? 'Undeafen' : 'Deafen'"
        :aria-pressed="selfDeafened"
        @click="$emit('toggleDeafen')"
      >
        <Icon name="headphones" :size="20" :slash="selfDeafened" />
      </button>
      <button
        type="button"
        class="btn"
        :class="{ on: spatial }"
        :title="spatialLabel ?? 'Spatial Audio'"
        :aria-label="spatialLabel ?? 'Spatial Audio'"
        :aria-pressed="!!spatial"
        @click="$emit('toggleSpatial')"
      >
        <Icon name="spatial" :size="20" />
      </button>
      <button type="button" class="btn danger" title="Disconnect" aria-label="Disconnect" @click="$emit('leave')">
        <Icon name="hangup" :size="20" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--bg-stage);
}
.overlay.bare {
  background: transparent;
}
/* Over whatever's on the screen, only the table's rim says where it is: no
   top, and a dark line beside the light one so it shows on anything. */
.bare .table {
  background: none;
  border-color: rgba(255, 255, 255, 0.45);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  opacity: var(--dim);
}
.bare .felt {
  display: none;
}
/* No fades: the overlay draws without the GPU, where each frame of one is
   painted again in full, and someone's ring changes several times a second
   in a lively call. Snapping, each change is one frame. */
.bare .seat .ring,
.bare .seat .tag {
  opacity: var(--dim);
  transition: none;
}
.bare .seat.speaking .ring,
.bare .seat.speaking .tag {
  opacity: 1;
}
.bare .seat.away .ring {
  opacity: calc(var(--dim) * 0.45);
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
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
}

.seat {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--avatar);
  height: var(--avatar);
}
.ring {
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--bg-stage);
  transition: box-shadow 0.08s ease;
}
/* Something's coming through, but not speech: a thin line where the ring goes. */
.seat.audible .ring {
  box-shadow:
    0 0 0 2px var(--bg-stage),
    0 0 0 3px var(--green);
}
.seat.speaking .ring {
  box-shadow:
    0 0 0 2px var(--bg-stage),
    0 0 0 5px var(--green);
}
.seat.away .ring {
  opacity: 0.45;
}
.under {
  /* Centred by layout, not by a -50% transform, so text sits on whole pixels. */
  position: absolute;
  top: 100%;
  left: -60px;
  right: -60px;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.tag {
  margin-top: calc(6px * var(--k));
  display: flex;
  align-items: center;
  gap: 3px;
  max-width: calc(80px * var(--k));
  padding: 1px calc(6px * var(--k));
  border-radius: 4px;
  background: var(--bg-floating);
  color: #fff;
  font-size: calc(12px * var(--k));
  font-weight: 500;
  line-height: calc(16px * var(--k));
  white-space: nowrap;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.state {
  color: var(--interactive-normal);
}
.self .tag {
  background: rgba(88, 101, 242, 0.85);
}

.controls {
  flex: none;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border-top: 1px solid var(--border-subtle);
}
.btn {
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: var(--bg-secondary);
  color: var(--interactive-hover);
}
.btn:hover {
  background: var(--bg-accent);
  color: var(--interactive-active);
}
.btn.off {
  background: #f2f3f5;
  color: #313338;
}
.btn.off:hover {
  background: #dbdee1;
}
.btn.on {
  background: var(--brand);
  color: #fff;
}
.btn.on:hover {
  background: var(--brand-hover);
}
.btn.danger {
  width: 52px;
  border-radius: 18px;
  background: var(--red-strong);
  color: #fff;
}
.btn.danger:hover {
  background: var(--red-hover);
}
</style>
