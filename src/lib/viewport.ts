import { onBeforeUnmount, ref, type Ref } from 'vue'

/**
 * Small screens: phones in either orientation (narrow, or short with a
 * touch screen). There the people are a list of tiles unless spatial audio
 * is on, panels are sheets across the screen, and tapping someone opens
 * their menu.
 */
export const COMPACT_QUERY = '(max-width: 640px), (pointer: coarse) and (max-height: 520px)'

/** No mouse to hover with: a tap is how you reach things a right-click would. */
export const touchFirst = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches

/** Whether the screen is small right now, kept up to date while the calling component lives. */
export function useCompact(): Ref<boolean> {
  const mq = typeof matchMedia === 'function' ? matchMedia(COMPACT_QUERY) : null
  const compact = ref(mq?.matches ?? false)
  const onChange = (e: MediaQueryListEvent) => (compact.value = e.matches)
  mq?.addEventListener('change', onChange)
  onBeforeUnmount(() => mq?.removeEventListener('change', onChange))
  return compact
}
