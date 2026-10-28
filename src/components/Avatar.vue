<script setup lang="ts">
import { computed } from 'vue'
import { Blobatar } from '@blobatar/vue'
import { happy, idle, sleepy, thinking } from 'blobatar/expression'

/**
 * Everyone's face is a blobatar (https://blobatar.dev), made from their
 * name, so the same name is the same creature for everyone in the room.
 * It smiles while they talk, dozes off while they're deafened and looks
 * puzzled while reconnecting.
 *
 * Static on purpose: one <img> each. Animated ones are inline SVG driven by
 * CSS animations on custom properties, which restyle every face every
 * frame on the main thread. With six at the table that was a whole core in
 * style recalc (more with the route cards up), and the audio paid for it.
 */

const props = withDefaults(
  defineProps<{
    name: string
    size?: number
    mood?: 'idle' | 'talking' | 'deafened' | 'away'
  }>(),
  { size: 40, mood: 'idle' }
)

const expression = computed(() => {
  switch (props.mood) {
    case 'talking':
      return happy
    case 'deafened':
      return sleepy
    case 'away':
      return thinking
    default:
      return idle
  }
})
</script>

<template>
  <div class="avatar" :style="{ width: size + 'px', height: size + 'px' }" aria-hidden="true">
    <Blobatar :name="name || '?'" :size="Math.round(size * 1.08)" :background="false" :expression="expression" />
  </div>
</template>

<style scoped>
.avatar {
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: #383a40;
  overflow: hidden;
  user-select: none;
  flex: none;
}
.avatar :deep(img),
.avatar :deep(svg) {
  display: block;
}
</style>
