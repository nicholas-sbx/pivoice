<script setup lang="ts">
import { computed } from 'vue'
import { call, updatePrefs } from '../call'
import { isNative } from '../native/bridge'
import { APP_DOWNLOADS, downloadUrl, onMobileDevice, visitorOS } from '../native/downloads'
import Icon from './Icon.vue'

/**
 * Discord's notice bar, under the top bar: on the website, on a computer
 * there's an app for, an offer of the app (its audio skips the browser's
 * buffers). The X puts it away for good on this browser.
 */

const version = __NATIVE_VERSION__
const app = isNative || onMobileDevice() ? undefined : APP_DOWNLOADS.find(d => d.os === visitorOS())
const show = computed(() => !!app && !call.prefs.appBannerDismissed)
const href = app ? downloadUrl(version, app.file(version)) : ''
</script>

<template>
  <div v-if="show && app" class="banner" role="region" aria-label="Get the app">
    <span class="text">
      Get lower latency, better performance, and an in game overlay in desktop app.
    </span>
    <a class="get" :href="href" :download="app.file(version)" rel="noopener">Download for {{ app.label }}</a>
    <button type="button" class="x" aria-label="Dismiss" title="Dismiss" @click="updatePrefs({ appBannerDismissed: true })">
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
  background: var(--brand);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  line-height: 18px;
  text-align: center;
}
.get {
  flex: none;
  padding: 3px 12px;
  border: 1px solid #fff;
  border-radius: 3px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.get:hover {
  background: #fff;
  color: var(--brand);
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
  color: #fff;
  opacity: 0.8;
  cursor: pointer;
}
.x:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.15);
}
</style>
