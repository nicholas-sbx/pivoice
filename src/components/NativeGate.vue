<script setup lang="ts">
import { computed } from 'vue'
import { copyText } from '../lib/copyText'
import { toast } from '../call'
import { forgetApp, native } from '../native/bridge'
import { APP_DOWNLOADS, downloadUrl } from '../native/downloads'

/**
 * In the app, when the page and the app can't work together: which of the
 * two is behind, and what to do about it. They're released separately, so
 * it can be either: an old app needs downloading again; an old page (the
 * app is newer than the site it loaded) needs the app restarting, which
 * loads the site afresh.
 */

const inWindow = typeof window !== 'undefined' && !!window.__pivoiceNative
const verdict = computed(() => native.verdict)
const latest = computed(() => (verdict.value && !verdict.value.ok && verdict.value.action === 'download' ? verdict.value.latest : ''))
// Straight to the file for the platform this app runs on; the release's page otherwise.
const file = computed(() => APP_DOWNLOADS.find(d => d.os === native.app?.os))
const link = computed(() => (latest.value ? downloadUrl(latest.value, file.value?.file) : ''))
const page = computed(() => (latest.value ? downloadUrl(latest.value) : ''))

function reload() {
  location.reload()
}

async function copyLink() {
  if (await copyText(link.value)) toast('Download link copied', 'success', 2500)
}
</script>

<template>
  <div v-if="native.state === 'mismatch' || native.state === 'lost'" class="gate" role="alertdialog" aria-labelledby="gate-title">
    <section class="card">
      <template v-if="native.state === 'lost'">
        <h1 id="gate-title">Lost the Pivoice app</h1>
        <p>
          The page can't reach the app any more. It may have quit: open Pivoice again
          {{ inWindow ? 'and this window comes back with it.' : 'and it opens a fresh page for you.' }}
        </p>
        <div class="actions">
          <button type="button" class="primary" @click="reload">Try Again</button>
          <button v-if="!inWindow" type="button" @click="forgetApp">Use This Browser Instead</button>
        </div>
      </template>
      <template v-else-if="verdict && !verdict.ok && verdict.action === 'download'">
        <h1 id="gate-title">Update the Pivoice app</h1>
        <p>
          This app (version {{ native.app?.version }}) is too old for the site. Download version {{ verdict.latest }}, quit this
          one, and open the new one.
        </p>
        <code class="link">{{ link }}</code>
        <div class="actions">
          <a class="button primary" :href="link" target="_blank" rel="noopener">
            Download {{ verdict.latest }}<template v-if="file"> for {{ file.label }}</template>
          </a>
          <button type="button" @click="copyLink">Copy Link</button>
          <a v-if="file" class="button" :href="page" target="_blank" rel="noopener">All Platforms</a>
        </div>
      </template>
      <template v-else>
        <h1 id="gate-title">Restart the Pivoice app</h1>
        <p>
          This app (version {{ native.app?.version }}) is newer than the page it loaded. Quit Pivoice and open it again to load
          the current site. Still here after that? The site's update is on its way: try again in a few minutes.
        </p>
        <div class="actions">
          <button type="button" class="primary" @click="reload">Reload</button>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.gate {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--bg-stage);
}
.card {
  width: min(480px, 100%);
  padding: 28px;
  border-radius: 8px;
  background: var(--bg-primary);
  box-shadow: var(--elevation-high);
  color: var(--text-normal);
}
h1 {
  margin: 0 0 12px;
  font-size: 20px;
  color: var(--header-primary);
}
p {
  margin: 0 0 16px;
  line-height: 1.45;
  font-size: 15px;
}
.link {
  display: block;
  margin: 0 0 16px;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--input-bg);
  font-size: 13px;
  overflow-wrap: anywhere;
  user-select: all;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
button,
.button {
  padding: 10px 16px;
  border: 0;
  border-radius: 4px;
  background: var(--bg-accent);
  color: #fff;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
button:hover,
.button:hover {
  background: var(--bg-accent-hover);
}
.primary {
  background: var(--brand);
}
.primary:hover {
  background: var(--brand-hover);
}
</style>
