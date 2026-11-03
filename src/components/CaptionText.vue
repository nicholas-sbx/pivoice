<script setup lang="ts">
import { computed } from 'vue'
import type { CaptionView } from '../captions/board'

/**
 * What someone's saying, as text: their last few phrases and the one in
 * progress, a line each and newest at the bottom, held to `lines` lines by clipping the
 * oldest off the top. Plain text (Vue escapes it), however it came.
 */
const props = defineProps<{ view: CaptionView; lines: number; scale: number }>()
const text = computed(() => props.view.lines.slice(-props.lines))
</script>

<template>
  <div class="caption" :style="{ '--lines': lines, '--scale': scale }" aria-live="polite">
    <span v-for="(line, i) in text" :key="i" class="line" :class="{ live: view.live && i === text.length - 1 }">{{ line }}</span>
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
/* Still being said: a shade dimmer until it's settled. */
.live {
  color: var(--text-normal);
}
</style>
