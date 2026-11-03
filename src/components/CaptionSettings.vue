<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { call, captionModel, downloadCaptionModel, forgetCaptionModel, updateCaptions } from '../call'
import { CAPTION_DEFAULTS, CAPTION_RANGES, type CaptionPrefs } from '../captions/config'
import { MODELS, cachedFiles, forgetModel, inBrowser, modelOf, streams, type ModelId } from '../captions/models'
import { captions } from '../captions/state'
import { isNative, native } from '../native/bridge'
import Segmented from './Segmented.vue'
import Slider from './Slider.vue'
import Switch from './Switch.vue'

/**
 * The captions tab: what recognises you and how, and how everyone's
 * captions are shown. Everything applies live; choosing another model
 * starts the recogniser again with it.
 */

const c = computed(() => call.prefs.captions)
const set = <K extends keyof CaptionPrefs>(k: K, v: CaptionPrefs[K]) => updateCaptions({ [k]: v } as Partial<CaptionPrefs>)
const r = CAPTION_RANGES

// In the app, only the models it can run here (natively); in a browser, all but the app's own.
const models = computed(() => (isNative ? MODELS.filter(m => native.app?.captions?.includes(m.id)) : MODELS.filter(inBrowser)))
const appOnly = computed(() => (isNative ? [] : MODELS.filter(m => !inBrowser(m)).map(m => m.title)))
const chosen = computed(() => captionModel())
const model = computed(() => modelOf(chosen.value))
const engine = computed(() => model.value?.engine)
const streaming = computed(() => streams(engine.value))
const noCaptions = computed(() => isNative && !models.value.length)

const download: { value: CaptionPrefs['download']; label: string }[] = [
  { value: 'wifi', label: 'Not on data' },
  { value: 'ask', label: 'Always ask' },
  { value: 'always', label: 'Always' }
]
const downloadHint: Record<CaptionPrefs['download'], string> = {
  wifi: "Downloads by itself unless you're on mobile data (or on a phone that won't say), and asks first then.",
  ask: 'Asks every time before downloading.',
  always: 'Downloads without asking, even on mobile data.'
}
const sources: { value: CaptionPrefs['source']; label: string }[] = [
  { value: 'raw', label: 'Unprocessed' },
  { value: 'call', label: 'As the call hears it' }
]

const phaseText = computed(() => {
  const m = captions.model
  const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`
  switch (m.phase) {
    case 'off':
      return c.value.send ? (call.phase === 'room' ? 'Not started.' : 'Starts when you join a call.') : 'Off.'
    case 'checking':
      return 'Looking for it…'
    case 'needed':
      return `Needs downloading: ${mb(m.total)}.`
    case 'downloading':
      return `Downloading: ${mb(m.bytes)} of ${mb(m.total)}.`
    case 'loading':
      return 'Loading it…'
    case 'ready':
      return captions.listening ? 'Ready, and listening for your ring.' : 'Ready.'
    case 'error':
      return `Couldn't start: ${m.error}`
  }
  return ''
})
const progress = computed(() => (captions.model.phase === 'downloading' && captions.model.total ? captions.model.bytes / captions.model.total : null))

const speed = computed(() => {
  const rtf = captions.rtf
  if (rtf === null) return ''
  const note = rtf < 0.5 ? 'keeps up easily' : rtf < 1 ? 'keeps up' : "can't keep up: try fewer live updates, or a smaller model"
  return `${rtf.toFixed(2)}× real time (${note})`
})

// In a browser: whether it's downloaded here (for "remove"), checked when the tab opens.
const here = ref<boolean | null>(null)
async function checkHere() {
  const m = model.value
  if (!m || isNative) return
  const have = await cachedFiles(new URL('captions/', document.baseURI).href, m)
  here.value = have.size === m.files.length
}
onMounted(() => void checkHere())
async function remove() {
  const m = model.value
  if (!m) return
  forgetCaptionModel()
  if (!isNative) {
    await forgetModel(new URL('captions/', document.baseURI).href, m)
    await checkHere()
  }
}
function pick(id: ModelId) {
  set('model', id)
  void checkHere()
}

function reset() {
  const keep = { model: c.value.model, send: c.value.send, show: c.value.show, showOwn: c.value.showOwn, download: c.value.download }
  updateCaptions({ ...CAPTION_DEFAULTS, ...keep })
}
</script>

<template>
  <div class="captions-tab">
    <p v-if="noCaptions" class="note first">This version of the app can't do captions here. Captions from people on the website still show.</p>

    <div class="row">
      <span class="eyebrow">Live Captions</span>
      <Switch
        label="Caption Me"
        hint="Recognises your voice on this device while your ring is lit, and sends the words to everyone. Your audio never leaves your device for it."
        :disabled="noCaptions"
        :model-value="c.send && !noCaptions"
        @update:model-value="v => set('send', v)"
      />
      <Switch label="Show Captions" hint="Everyone else's, beside them." :model-value="c.show" @update:model-value="v => set('show', v)" />
      <Switch label="Show My Own" hint="Yours beside you, as everyone sees them." :model-value="c.showOwn" @update:model-value="v => set('showOwn', v)" />
    </div>

    <template v-if="c.send && !noCaptions">
      <div class="row">
        <span class="eyebrow">Recogniser</span>
        <div class="models" role="radiogroup">
          <button
            v-for="m in models"
            :key="m.id"
            type="button"
            role="radio"
            class="model"
            :aria-checked="chosen === m.id"
            :class="{ active: chosen === m.id }"
            @click="pick(m.id)"
          >
            <span class="model-top">
              <strong>{{ m.title }}</strong>
              <span class="size">{{ m.downloadMB }} MB</span>
            </span>
            <span class="model-detail">{{ m.detail }}</span>
          </button>
        </div>
        <p class="note">
          They all run on the CPU; none needs a graphics card.
          {{ isNative ? 'In the app, natively, in a process of its own, at normal priority, so the call’s audio always comes first.' : 'In a browser, as WebAssembly in a worker of its own, on one thread.' }}
          <template v-if="appOnly.length">{{ appOnly.join(', ') }} is in the app only: as WebAssembly it can't keep up.</template>
        </p>
        <div class="status" aria-live="polite">
          <span>{{ phaseText }}</span>
          <div v-if="progress !== null" class="bar"><div class="fill" :style="{ transform: `scaleX(${progress})` }" /></div>
          <span v-if="speed" class="dim">{{ speed }}</span>
          <span v-if="captions.lost" class="dim">{{ (captions.lost / 48_000).toFixed(1) }} s of speech dropped: it fell too far behind.</span>
        </div>
        <div class="actions">
          <button v-if="captions.model.phase === 'needed'" type="button" class="link" @click="downloadCaptionModel">Download now</button>
          <button
            v-if="isNative || here"
            type="button"
            class="link"
            title="Frees the space. It's only downloaded again when you ask, or in your next call (turn off Caption Me to keep it off)."
            @click="remove"
          >
            Remove downloaded copy
          </button>
        </div>
        <p class="note credit">
          <a :href="model?.url" target="_blank" rel="noopener">{{ model?.credit }}</a>
        </p>
      </div>

      <div class="row">
        <span class="eyebrow">Download</span>
        <Segmented :options="download" :model-value="c.download" @update:model-value="v => set('download', v)" />
        <p class="note">
          {{ downloadHint[c.download] }}
          {{ isNative ? 'The app keeps it in your cache folder.' : 'Kept by this browser, so it’s only downloaded once.' }}
        </p>
      </div>

      <div class="row">
        <span class="eyebrow">What It Hears</span>
        <Segmented v-if="!isNative" :options="sources" :model-value="c.source" @update:model-value="v => set('source', v)" />
        <p class="note">
          Your mic with none of the noise suppression or automatic gain the call uses, so it gets all of your voice. The one exception is echo cancellation:
          when that's on, captions hear the echo-cancelled mic, since you're probably on speakers and the raw mic would caption you saying everyone else's
          words.
          <template v-if="!isNative">
            {{
              c.source === 'raw'
                ? 'Where the call’s own capture isn’t that, a second capture of the same mic (not on Safari or phones, which can’t without disturbing the call).'
                : 'Set to the call’s own capture, processed as the call hears it.'
            }}
          </template>
          The ring still goes by what the call hears.
        </p>
        <p v-if="captions.hearing.detail" class="note hearing" aria-live="polite">
          <strong>Hearing now:</strong>
          {{ captions.hearing.kind === 'call' ? 'the call’s capture' : captions.hearing.kind === 'app' ? 'the app' : 'a capture for captions' }}
          ({{ captions.hearing.detail }}{{ captions.hearing.kind === 'app' ? '' : ', as the browser reports it' }}): {{ captions.hearing.note }}.
        </p>
      </div>

      <div class="row">
        <span class="eyebrow">When</span>
        <Slider
          label="Before the ring"
          unit=" ms"
          :min="r.preRollMs[0]"
          :max="r.preRollMs[1]"
          :step="r.preRollMs[2]"
          hint="The last this-much of your mic is kept, and recognised in a burst the moment your ring lights, so the first word isn’t lost."
          :model-value="c.preRollMs"
          @update:model-value="v => set('preRollMs', v)"
        />
        <Slider
          label="After the ring"
          unit=" ms"
          :min="r.postRollMs[0]"
          :max="r.postRollMs[1]"
          :step="r.postRollMs[2]"
          hint="It keeps listening this long after your ring goes out (on top of the ring’s own 300 ms), then finishes the phrase."
          :model-value="c.postRollMs"
          @update:model-value="v => set('postRollMs', v)"
        />
      </div>

      <div class="row">
        <span class="eyebrow">Live Words</span>
        <Switch
          label="Words as you say them"
          hint="Off: only whole phrases, once they're finished."
          :model-value="c.partials"
          @update:model-value="v => set('partials', v)"
        />
        <Slider
          v-if="streaming"
          label="Updates a second"
          :min="r.partialsPerSec[0]"
          :max="r.partialsPerSec[1]"
          :step="r.partialsPerSec[2]"
          :hint="engine === 'vosk' ? 'The most times a second your words so far go out.' : 'The most times a second your words so far go out (FastConformer only has new ones once a chunk: see its description).'"
          :disabled="!c.partials"
          :model-value="c.partialsPerSec"
          @update:model-value="v => set('partialsPerSec', v)"
        />
        <Slider
          v-if="engine === 'vosk'"
          label="Leave out unsure words"
          unit="%"
          :min="0"
          :max="95"
          :step="5"
          :hint="c.minConfidence > 0 ? `Finished phrases leave out words it's less than ${Math.round(c.minConfidence * 100)}% sure of.` : 'Off: every word it hears goes out.'"
          :model-value="Math.round(c.minConfidence * 100)"
          @update:model-value="v => set('minConfidence', v / 100)"
        />
        <Slider
          v-if="!streaming"
          label="Read again every"
          unit=" ms"
          :min="r.rereadMs[0]"
          :max="r.rereadMs[1]"
          :step="r.rereadMs[2]"
          hint="Parakeet hears a phrase whole, so live words are the phrase so far read again: more often is livelier and costs more CPU. Skipped while it's behind."
          :disabled="!c.partials"
          :model-value="c.rereadMs"
          @update:model-value="v => set('rereadMs', v)"
        />
        <Slider
          v-if="engine !== 'vosk'"
          label="Longest phrase"
          unit=" s"
          :min="r.maxPhraseSec[0]"
          :max="r.maxPhraseSec[1]"
          :step="r.maxPhraseSec[2]"
          :hint="
            streaming
              ? 'Talking longer than this without a pause, the phrase ends at the next word and a new one starts, so captions stay a size to read. It costs nothing: the model carries straight on.'
              : 'Talking longer than this without a pause, the phrase is finished there and a new one starts: each read costs more the longer it is.'
          "
          :model-value="c.maxPhraseSec"
          @update:model-value="v => set('maxPhraseSec', v)"
        />
        <Slider
          v-if="isNative"
          label="CPU threads"
          :min="r.threads[0]"
          :max="r.threads[1]"
          :step="r.threads[2]"
          hint="How many cores the recogniser may use at once. More gets through Parakeet's phrases and FastConformer's chunks sooner; the call's audio keeps priority either way."
          :model-value="c.threads"
          @update:model-value="v => set('threads', v)"
        />
      </div>
    </template>

    <div class="row">
      <span class="eyebrow">Showing Them</span>
      <Slider
        label="Lines"
        :min="r.lines[0]"
        :max="r.lines[1]"
        :step="r.lines[2]"
        hint="Of each person's captions at once (one in a list of people)."
        :model-value="c.lines"
        @update:model-value="v => set('lines', v)"
      />
      <Slider
        label="Size"
        unit="%"
        :min="75"
        :max="150"
        :step="5"
        :model-value="Math.round(c.scale * 100)"
        @update:model-value="v => set('scale', v / 100)"
      />
      <Slider
        label="Stay up for"
        unit=" s"
        :min="r.lingerSec[0]"
        :max="r.lingerSec[1]"
        :step="r.lingerSec[2]"
        hint="After someone's last word."
        :model-value="c.lingerSec"
        @update:model-value="v => set('lingerSec', v)"
      />
      <button type="button" class="link spaced" @click="reset">Reset captions to defaults</button>
    </div>
  </div>
</template>

<style scoped>
.row {
  margin-top: 16px;
}
.row:first-child {
  margin-top: 0;
}
.eyebrow {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--header-secondary);
}
.note {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}
.note.first {
  margin: 0 0 8px;
}
.models {
  display: grid;
  gap: 8px;
}
.model {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-normal);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.model:hover {
  background: var(--bg-modifier-hover);
}
.model.active {
  border-color: var(--brand);
  box-shadow: inset 0 0 0 1px var(--brand);
}
.model-top {
  display: flex;
  justify-content: space-between;
  color: var(--header-primary);
  font-size: 14px;
}
.size {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.model-detail {
  color: var(--text-muted);
}
.status {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  font-size: 13px;
  color: var(--header-primary);
}
.dim {
  color: var(--text-muted);
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-accent);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--brand);
  transform-origin: left center;
}
.actions {
  display: flex;
  gap: 16px;
  margin-top: 6px;
}
.link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--text-link);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.link:hover {
  text-decoration: underline;
}
.link.spaced {
  margin: 4px 0 8px;
}
.credit a {
  color: var(--text-muted);
}
.hearing strong {
  color: var(--header-secondary);
  font-weight: 600;
}
</style>
