<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { captionModel } from '../call'
import { captions, acceptDownload, declineDownload } from '../captions/state'
import { modelOf } from '../captions/models'
import Icon from './Icon.vue'

/**
 * Asking before the captions model downloads, under the top bar like the
 * app's notice: on mobile data (or a phone that won't say), or when the
 * settings say always to ask. "Not now" holds off for this call; it goes
 * ahead by itself if you move to Wi-Fi meanwhile.
 *
 * On data (or maybe on it), it also says what the call itself costs: a lot,
 * on purpose. Voices go as raw PCM with no codec, which is what keeps the
 * delay this low (see the README, "Bigger rooms" and "Why no Opus"), at
 * about 1 Mbit/s each way per person while they talk.
 *
 * Then, in the same place, the download itself: a bar that comes up as soon
 * as it starts (by itself, or after "Download"), stays while the model is
 * made ready, and goes once captions are. Its X only hides it; the download
 * carries on. A model you switch to shows the same place while it's getting
 * ready, even when it was already here (then there's no bar, just the news).
 */

const p = computed(() => captions.prompt)
const title = computed(() => (p.value ? (modelOf(p.value.model)?.title ?? 'The captions model') : ''))
const size = computed(() => (p.value ? `${Math.max(1, Math.round(p.value.bytes / 1e6))} MB` : ''))
// Why it's asking: only when it's the connection (not just the settings' "Always ask").
const why = computed(() =>
  !p.value?.network ? '' : p.value.metered === 'yes' ? "You're on mobile data." : "This device doesn't say whether it's on mobile data."
)
/** Maybe on data: say what calls cost too. */
const onData = computed(() => !!p.value?.network)

// ---- the download, once it's going ----

/** Downloading this call (so "getting it ready" after it, and an error from it, show; a model already here doesn't). */
const fetching = ref(false)
const hidden = ref(false)
/**
 * A model you just chose, getting ready: shown even when it was already
 * downloaded here, so switching says it's happening rather than looking
 * like nothing did.
 */
const switching = ref(false)
watch(
  () => captionModel(),
  (now, before) => {
    if (!before || now === before) return
    switching.value = true
    hidden.value = false
  }
)
watch(
  () => captions.model.phase,
  phase => {
    if (phase === 'downloading' && !fetching.value) {
      fetching.value = true
      hidden.value = false
    } else if (phase === 'ready' || phase === 'off' || phase === 'checking') fetching.value = false
    if (phase === 'ready') switching.value = false
  },
  { immediate: true }
)
const phase = computed(() => captions.model.phase)
const busy = computed(() => fetching.value || switching.value)
/** Not while it's only `needed`: that's the prompt's to say, and after "Not now" a banner would sit there saying it still is. */
const showProgress = computed(
  () => !p.value && busy.value && !hidden.value && ['checking', 'downloading', 'loading', 'error'].includes(phase.value)
)
const modelTitle = computed(() => modelOf(captionModel())?.title ?? 'the captions model')
const fraction = computed(() => {
  if (phase.value === 'loading') return 1
  const { bytes, total } = captions.model
  return total > 0 ? Math.min(1, bytes / total) : 0
})
/** A bar only where there's progress to show: a model already here has none to know. */
const showTrack = computed(() => phase.value === 'downloading' || (phase.value === 'loading' && fetching.value))
const mb = (n: number) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0)
const progressText = computed(() => {
  const m = captions.model
  if (phase.value === 'loading') {
    return fetching.value
      ? `Downloaded ${modelTitle.value}. Getting live captions ready…`
      : `Getting ${modelTitle.value} ready for live captions…`
  }
  if (phase.value === 'error') return `Couldn't get ${modelTitle.value} for live captions: ${m.error}`
  if (phase.value !== 'downloading') return `Switching live captions to ${modelTitle.value}…`
  return `Downloading ${modelTitle.value} for live captions: ${mb(m.bytes)} of ${mb(m.total)} MB`
})
</script>

<template>
  <div v-if="p" class="banner" role="region" aria-label="Captions download">
    <span class="text">
      Live captions need {{ title }}, a one-time {{ size }} download. {{ why }}
      <small v-if="onData" class="data">
        Calls here use a lot of data, and that's on purpose: voices go uncompressed, which is what keeps the delay so low. That's about 1 Mbit/s to and
        from each person while they talk, up to 450 MB an hour each.
      </small>
    </span>
    <button type="button" class="get" @click="acceptDownload">Download</button>
    <button type="button" class="x" aria-label="Not now" title="Not now" @click="declineDownload">
      <Icon name="close" :size="18" />
    </button>
  </div>
  <div v-else-if="showProgress" class="banner progress" :class="{ bad: phase === 'error' }" role="region" aria-label="Live captions">
    <span class="text" aria-live="polite">{{ progressText }}</span>
    <div
      v-if="showTrack"
      class="track"
      role="progressbar"
      aria-label="Captions download"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(fraction * 100)"
    >
      <div class="fill" :class="{ done: phase === 'loading' }" :style="{ transform: `scaleX(${fraction})` }" />
    </div>
    <button type="button" class="x" aria-label="Hide" :title="phase === 'error' ? 'Close' : phase === 'downloading' ? 'Hide (it carries on downloading)' : 'Hide'" @click="hidden = true">
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
.text {
  max-width: 760px;
}
.data {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
  color: var(--text-muted);
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
/* The download's bar: flat, a hard-edged track and its fill, no gradients. */
.progress {
  flex-direction: column;
  gap: 6px;
  padding-top: 7px;
  padding-bottom: 8px;
}
.track {
  width: min(420px, 100%);
  height: 4px;
  border-radius: 2px;
  background: var(--bg-accent);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--brand);
  transform-origin: left center;
  transition: transform 0.15s linear;
}
.fill.done {
  background: var(--green);
}
.progress .text {
  font-variant-numeric: tabular-nums;
}
.progress.bad .text {
  color: var(--red);
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
