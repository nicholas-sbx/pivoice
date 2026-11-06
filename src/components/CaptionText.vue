<script setup lang="ts">
import { computed } from 'vue'
import type { CaptionView } from '../captions/board'
import { captionParts } from '../captions/display'

/**
 * What someone's saying, as text: their last few phrases and the one in
 * progress, one flowing block (no line per phrase), held to `lines` lines by
 * clipping the oldest off the top. Older phrases fade by how many phrases
 * back they are, by `fade`; the one still being said is a shade dimmer than
 * the rest. `caret` draws a blinking caret after the last words, for when
 * more are expected. Plain text (Vue escapes it), however it came. Not
 * aria-live: everyone's words, several updates a second each, would bury a
 * screen reader.
 */
const props = defineProps<{
  view: CaptionView
  lines: number
  scale: number
  /** How much each phrase older than the newest fades: 0 is not at all. */
  fade: number
  /** Show a caret after the last words (more are expected). */
  caret: boolean
}>()

const parts = computed(() => captionParts(props.view.lines, props.view.live, props.fade))
</script>

<template>
  <div class="caption" :style="{ '--lines': lines, '--scale': scale }">
    <div class="body">
      <span v-for="(part, i) in parts" :key="i" :class="{ live: part.live }" :style="{ opacity: part.opacity }">{{ part.text }}</span>
      <span v-if="caret && parts.length" class="caret" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.caption {
  /* Newest last: content that doesn't fit is cut off at the top, so the latest words always show. */
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  max-height: calc(var(--lines) * 1.35em + 8px);
  overflow: hidden;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--bg-floating);
  border: 1px solid var(--border-strong);
  color: var(--header-primary);
  font-size: calc(14px * var(--scale));
  line-height: 1.35;
  font-weight: 500;
  text-align: left;
  overflow-wrap: anywhere;
  pointer-events: none;
}
.body {
  /* Never shrink to fit: the overflow is what gets clipped off the top. */
  flex: none;
  min-width: 0;
}
/* Still being said: a shade dimmer until it's settled. */
.live {
  color: var(--text-normal);
}
/* Expected words: a hard blink, so it reads as a cursor, not a fade. */
.caret {
  display: inline-block;
  width: 0.08em;
  height: 1em;
  margin-left: 1px;
  vertical-align: -0.12em;
  border-radius: 1px;
  background: currentColor;
  animation: caret-blink 1.1s steps(1, end) infinite;
}
@keyframes caret-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .caret {
    animation: none;
  }
}
</style>
