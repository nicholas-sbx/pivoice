<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Blobatar } from '@blobatar/vue'
import { useGaze } from '@blobatar/vue/gaze'
import { happy, idle, sleepy, thinking } from 'blobatar/expression'
import 'blobatar/motion.css'
import 'blobatar/gaze.css'

/**
 * Everyone's face is a blobatar (https://blobatar.dev), made from their
 * name, so the same name is the same creature for everyone in the room.
 * It idles (breathes, blinks), smiles while they talk, dozes off while
 * they're deafened, and looks over at whoever is talking.
 */

const props = withDefaults(
  defineProps<{
    name: string
    size?: number
    mood?: 'idle' | 'talking' | 'deafened' | 'away'
    /** Where the eyes should point: the seat of whoever's talking, or nothing. */
    look?: Element | null
    /** Changes whenever seats have finished moving, so the eyes re-aim at where things ended up. */
    layout?: number
  }>(),
  { size: 40, mood: 'idle', look: null, layout: 0 }
)

const blob = ref()
const { lookAt, remeasure } = useGaze(blob, { travel: 3 })

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

function aim() {
  remeasure()
  lookAt(props.look ?? null)
}

watch(() => props.look, aim)
watch(() => props.layout, aim)
onMounted(aim)
</script>

<template>
  <div class="avatar" :style="{ width: size + 'px', height: size + 'px' }" aria-hidden="true">
    <Blobatar ref="blob" :name="name || '?'" :size="Math.round(size * 1.08)" :background="false" animate="always" :expression="expression" />
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
.avatar :deep(svg) {
  display: block;
}
</style>
