<script setup lang="ts">
import { computed } from 'vue'
import { ICONS, type IconDef, type IconName } from './icons'

const props = withDefaults(defineProps<{ name: IconName; size?: number; slash?: boolean }>(), { size: 24, slash: false })

const maskId = `pv-slash-${Math.random().toString(36).slice(2)}`
const icon = computed<IconDef>(() => ICONS[props.name])
</script>

<template>
  <svg class="icon" :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true">
    <!-- Discord-style strike: a gap cut out of the icon, then a red line through it. -->
    <defs v-if="slash">
      <mask :id="maskId" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" />
        <line x1="2.5" y1="2.5" x2="21.5" y2="21.5" stroke="#000" stroke-width="5" stroke-linecap="round" />
      </mask>
    </defs>
    <g :mask="slash ? `url(#${maskId})` : undefined">
      <path v-for="d in icon.fill ?? []" :key="d" :d="d" fill="currentColor" />
      <path
        v-for="d in icon.stroke ?? []"
        :key="d"
        :d="d"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </g>
    <line v-if="slash" class="slash" x1="3" y1="3" x2="21" y2="21" stroke-width="2" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.icon {
  display: block;
  flex: none;
}
.slash {
  stroke: var(--red);
}
</style>
