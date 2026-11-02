<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import OverlayTable from '../components/OverlayTable.vue'
import { Seating } from '../lib/seating'
import type { OverlayLook, OverlayState, ToOverlay } from '../native/protocol'

/**
 * Everything here comes from the app, which puts `window.__pivoiceOverlay`
 * in the page before it loads (and only on the site's own origin):
 *
 *  - `state`: who's in the call and where they sit, copied from the page in
 *    the app's main window whenever it changes. The seats are that table's,
 *    not worked out again here, so a face is drawn where its voice is heard
 *    from;
 *  - `rings`: who's speaking, and who's making any sound, worked out by the
 *    app itself from the audio, and sent only when it changes (so a quiet
 *    call wakes this page not at all, and the main window being minimised,
 *    which slows its timers, doesn't slow the rings);
 *  - `look`: how faded it is, and whether it's being placed (an outline, so
 *    you can see where it is while you move it);
 *  - `repaint`: it's just been placed (or moved, or resized).
 *
 * It can't say anything back but that it's ready for them.
 */

declare global {
  interface Window {
    __pivoiceOverlay?: { onmessage: ((m: ToOverlay) => void) | null; ready(): void }
  }
}

const seating = new Seating(() => {})
const state = shallowRef<OverlayState | null>(null)
const look = reactive<OverlayLook>({ opacity: 0.8, scale: 1, placing: false })
const speaking = shallowRef(new Set<string>())
const audible = shallowRef(new Set<string>())

/**
 * Paints the whole window again, not only what changed. The window is
 * see-through and drawn without the GPU, and a frame of it can be lost as
 * it's placed or resized (seen on Linux): then only what's painted again
 * afterwards shows, which in a quiet call is a face and the bit of the
 * table's rim behind it, whenever its ring changes. A sheet over all of it,
 * too faint to see, for two frames, has it all painted again. Only when it's
 * placed, resized or the call changes, so the rings still cost one small
 * paint each.
 */
const fresh = ref(false)
let repainting = false
function repaint() {
  if (repainting) return
  repainting = true
  fresh.value = true
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      fresh.value = false
      repainting = false
    })
  )
}
window.addEventListener('resize', repaint)

function receive(m: ToOverlay) {
  if (m.t === 'state') {
    state.value = m.state
    repaint()
  } else if (m.t === 'look') {
    Object.assign(look, m.look)
    repaint()
  } else if (m.t === 'repaint') repaint()
  else if (m.t === 'rings') {
    // Your own mic is '' to the app, which doesn't know who you are.
    const you = (ids: string[]) => new Set(ids.map(id => id || (state.value?.selfId ?? '')))
    speaking.value = you(m.speaking)
    audible.value = you(m.audible)
  }
}

watch(state, s => {
  if (s) seating.mirror(s.seats, s.selfId)
  else seating.reset()
})

const api = window.__pivoiceOverlay
if (api) {
  api.onmessage = receive
  api.ready()
}
onBeforeUnmount(() => {
  if (api) api.onmessage = null
  window.removeEventListener('resize', repaint)
})
</script>

<template>
  <div class="frame" :class="{ placing: look.placing, fresh }">
    <OverlayTable
      v-if="state"
      bare
      :dim="look.opacity"
      :scale="look.scale"
      :seating="seating"
      :members="state.members"
      :self-id="state.selfId"
      :speaking="speaking"
      :audible="audible"
      :self-muted="state.selfMuted"
      :self-deafened="state.selfDeafened"
      :silenced="state.silenced"
    />
    <span v-if="look.placing" class="label">Overlay</span>
  </div>
</template>

<style scoped>
.frame {
  position: relative;
  width: 100%;
  height: 100%;
  border: 1px solid transparent;
}
/* Being placed: its edges, so you can see where it'll sit even with nobody at the table. */
.frame.placing {
  border-color: var(--brand);
  background: rgba(88, 101, 242, 0.12);
}
/* Over the whole window and as faint as there is (1/255): it's there only to be painted. */
.frame.fresh::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.004);
  pointer-events: none;
}
.label {
  position: absolute;
  left: 6px;
  top: 4px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--brand);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}
</style>
