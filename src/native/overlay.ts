import { computed, ref, watch } from 'vue'
import type { Seating } from '../lib/seating'
import type { Prefs } from '../lib/prefs'
import type { Member } from '../net/protocol'
import { native, type NativeBridge } from './bridge'
import type { AppMonitor, OverlayLook, OverlayPlace, OverlayState } from './protocol'

/**
 * The app's overlay (native/internal/overlay), from the page's side: while
 * it's switched on and you're in a call, the app is asked to show it where
 * your settings say, and it's sent the call whenever that changes (who's
 * there, where they sit, who's muted). The rings it works out itself, from
 * the audio. Nothing at all is sent while it's off.
 */

/** This app can show an overlay here. */
export const overlaySupported = computed(() => native.state === 'ready' && !!native.app?.overlay)
/** The overlay's settings are open: it shows its edges, so you can see where it is. */
export const overlayPlacing = ref(false)
/** Why it isn't up, if it isn't. */
export const overlayError = ref('')

let bridge: NativeBridge | null = null

/** What `driveOverlay` reads of the call. */
export interface OverlayCall {
  phase: string
  selfId: string
  members: Member[]
  muted: boolean
  deafened: boolean
  micProblem: unknown
  silenced: Record<string, boolean>
  prefs: Prefs
}

export function driveOverlay(b: NativeBridge, call: OverlayCall, seating: Seating) {
  bridge = b
  const shown = computed(() => overlaySupported.value && call.phase === 'room' && call.prefs.overlay.on)
  const place = computed<OverlayPlace>(() => {
    const o = call.prefs.overlay
    return { monitor: o.monitor, anchor: o.anchor, margin: o.margin, size: o.size }
  })
  // Not even worked out while it's off.
  const state = computed<OverlayState | null>(() => {
    if (!shown.value) return null
    // Seats move without the roster changing (and the other way round): both count.
    void seating.revision.value
    return {
      selfId: call.selfId,
      members: call.members.map(m => ({ ...m })),
      seats: seating.targets(),
      selfMuted: call.muted || call.deafened || !!call.micProblem,
      selfDeafened: call.deafened,
      silenced: { ...call.silenced }
    }
  })
  const look = computed<OverlayLook>(() => ({ opacity: call.prefs.overlay.opacity, scale: call.prefs.overlay.scale, placing: overlayPlacing.value }))

  // Compared as text: a change to one setting replaces them all, and only what really changed should go across.
  const placeKey = computed(() => JSON.stringify(place.value))
  const lookKey = computed(() => JSON.stringify(look.value))

  let up = false
  watch(
    [shown, placeKey],
    async ([on]) => {
      const p = place.value
      if (!on) {
        if (up) b.send({ t: 'overlay', op: 'hide' })
        up = false
        return
      }
      // The app keeps the latest of these (the state goes when it's worked out, below), and hands them to the overlay's page when it's loaded.
      b.send({ t: 'overlay', op: 'look', look: look.value })
      const r = await b.request({ t: 'overlay', op: 'show', place: p }, 'overlay', 10_000)
      if (!shown.value) return
      up = !!r?.on
      overlayError.value = r ? (r.error ?? '') : "The app didn't answer."
    },
    { immediate: true }
  )
  watch(state, s => {
    if (s) b.send({ t: 'overlay', op: 'state', state: s })
  })
  watch(lookKey, () => {
    if (shown.value) b.send({ t: 'overlay', op: 'look', look: look.value })
  })
}

/** The screens the overlay can go on, and what this desktop lets it do there. */
export async function listMonitors(): Promise<{ monitors: AppMonitor[]; placeable: boolean; onTop: boolean }> {
  const r = bridge ? await bridge.request({ t: 'monitors' }, 'monitors', 5000) : null
  return r ? { monitors: r.monitors, placeable: r.placeable, onTop: r.onTop } : { monitors: [], placeable: false, onTop: false }
}
