<script setup lang="ts">
import { ref } from 'vue'
import { seating } from '../call'
import { tableRadius } from '../lib/seats'
import { useSeatStates, useTableView } from '../lib/tableView'
import type { Member } from '../net/protocol'
import Avatar from './Avatar.vue'
import Icon from './Icon.vue'

/**
 * The table in miniature, for a small always-on-top window: the same seats
 * as the big one (from the call's shared seating), each face with its
 * speaking ring and the thin one for any sound, mute and deafen marks, and a
 * short name tag. Everything it needs is in its props, so whatever draws it
 * (the pop-out window now, the app's overlay later) only has to hand it a
 * snapshot of the call.
 *
 * It can be shown in another window than the page's, so it asks the element
 * it's in for the window (lib/tableView does) and never uses the global one:
 * the page's own window is often hidden then, and its animation frames are
 * paused.
 */

const props = defineProps<{
  members: Member[]
  selfId: string
  speaking: Set<string>
  /** Making any sound at all: a thin ring, under the full one for speaking. */
  audible: Set<string>
  selfMuted: boolean
  selfDeafened: boolean
  silenced: Record<string, boolean>
  /** Mute and deafen buttons under the table. */
  controls?: boolean
}>()

defineEmits<{ toggleMute: []; toggleDeafen: [] }>()

const root = ref<HTMLElement>()
const tableEl = ref<HTMLElement>()

const { geometry, member, setSeatEl, seatIds } = useTableView({
  seating,
  root,
  tableEl,
  members: () => props.members,
  selfId: () => props.selfId,
  geometry(w, h) {
    // Even, so its centre lands on a whole pixel.
    const avatar = 2 * Math.round(Math.max(28, Math.min(56, Math.min(w, h) * 0.16)) / 2)
    // A name tag under each face, and a little air round the edge.
    const label = 22
    const pad = 8
    const ringV = (h - 2 * pad - avatar - label) / 2
    // Name tags reach about this far out either side of a face.
    const ringH = w / 2 - Math.max(avatar / 2, 40) - pad
    const ring = Math.max(40, Math.min(240, ringV, ringH))
    const block = 2 * ring + avatar + label
    const cx = w / 2
    const cy = pad + Math.max(0, (h - 2 * pad - block) / 2) + avatar / 2 + ring
    return { avatar, ring, cx, cy }
  },
  radius: (g, present) => tableRadius(present, g.ring, g.avatar)
})

const { isSelf, mutedOf, deafenedOf, speakingOf, audibleOf, moodOf } = useSeatStates(props, member)
</script>

<template>
  <div class="overlay">
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
            <Icon v-if="mutedOf(id)" name="mic" :size="12" slash class="state" />
            <Icon v-if="deafenedOf(id)" name="headphones" :size="12" slash class="state" />
            <Icon v-if="silenced[id]" name="speaker" :size="12" slash class="state" />
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
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 3px;
  max-width: 80px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-floating);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
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
</style>
