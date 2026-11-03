<script setup lang="ts">
import { computed } from 'vue'
import { captions, acceptDownload, declineDownload } from '../captions/state'
import { modelOf } from '../captions/models'
import Icon from './Icon.vue'

/**
 * Asking before the captions model downloads, under the top bar like the
 * app's notice: on mobile data (or a phone that won't say), or when the
 * settings say always to ask. "Not now" holds off for this call; it goes
 * ahead by itself if you move to Wi-Fi meanwhile.
 */

const p = computed(() => captions.prompt)
const title = computed(() => (p.value ? (modelOf(p.value.model)?.title ?? 'The captions model') : ''))
const size = computed(() => (p.value ? `${Math.max(1, Math.round(p.value.bytes / 1e6))} MB` : ''))
const why = computed(() =>
  p.value?.metered === 'yes' ? "You're on mobile data." : p.value?.metered === 'unknown' ? "This device doesn't say whether it's on mobile data." : ''
)
</script>

<template>
  <div v-if="p" class="banner" role="region" aria-label="Captions download">
    <span class="text">Live captions need {{ title }}, a one-time {{ size }} download. {{ why }}</span>
    <button type="button" class="get" @click="acceptDownload">Download</button>
    <button type="button" class="x" aria-label="Not now" title="Not now" @click="declineDownload">
      <Icon name="close" :size="18" />
    </button>
  </div>
</template>

<style scoped>
.banner {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 6px 16px;
  min-height: 36px;
  padding: 6px 48px 6px calc(16px + env(safe-area-inset-left));
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-strong);
  color: var(--header-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 18px;
  text-align: center;
}
.get {
  flex: none;
  padding: 3px 12px;
  border: 0;
  border-radius: 3px;
  background: var(--brand);
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.get:hover {
  background: var(--brand-hover);
}
.x {
  position: absolute;
  top: 50%;
  right: calc(8px + env(safe-area-inset-right));
  width: 28px;
  height: 28px;
  margin-top: -14px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--interactive-normal);
  cursor: pointer;
}
.x:hover {
  color: var(--interactive-hover);
  background: var(--bg-modifier-hover);
}
</style>
