<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { call, startCall } from '../call'
import { t } from '../i18n'
import { isNative, native } from '../native/bridge'
import { APP_DOWNLOADS, downloadUrl, onMobileDevice, visitorOS } from '../native/downloads'
import Icon from '../components/Icon.vue'
import { codeFromHash, CODE_LENGTH, isRoomCode, normalizeRoomCode } from '../lib/roomCode'
import { cleanName } from '../net/protocol'

/** No landing page: make a room or join one by code, that's it. */

const name = ref(call.prefs.name)
const code = ref(codeFromHash(location.hash))
/** An invited code stays dotted out unless you start editing it. */
const revealCode = ref(false)
const nameError = ref('')
const codeError = ref('')
const nameInput = ref<HTMLInputElement>()
const codeInput = ref<HTMLInputElement>()
const fromInvite = !!code.value
// Read the invite, then take the code out of the address bar.
if (fromInvite) history.replaceState(null, '', location.pathname + location.search)
const busy = computed(() => call.phase === 'joining')
const version = __APP_VERSION__
// On the website: the app for each platform, yours first and highlighted.
const appVersion = __NATIVE_VERSION__
const mine = visitorOS()
// Not on a phone or tablet: there's no app for those.
const downloads = onMobileDevice() ? [] : [...APP_DOWNLOADS].sort((a, b) => Number(b.os === mine) - Number(a.os === mine))
// In the app, when a newer one's out: the file for the platform it runs on.
const newerUrl = computed(() => {
  const v = native.verdict?.ok ? native.verdict.newer : null
  return v ? downloadUrl(v, APP_DOWNLOADS.find(d => d.os === native.app?.os)?.file(v)) : ''
})

function checkName(): string | null {
  const n = cleanName(name.value)
  if (!n) {
    nameError.value = t('home.required')
    nameInput.value?.focus()
    return null
  }
  nameError.value = ''
  return n
}

function create() {
  if (busy.value) return
  codeError.value = ''
  const n = checkName()
  if (n) void startCall('create', n)
}

function join() {
  if (busy.value) return
  const c = normalizeRoomCode(code.value)
  if (!isRoomCode(c)) {
    codeError.value = c ? t('home.codeLength', { length: CODE_LENGTH }) : t('home.codeEnter')
    codeInput.value?.focus()
    return
  }
  codeError.value = ''
  const n = checkName()
  if (n) void startCall('join', n, c)
}

function onCode(e: Event) {
  revealCode.value = true
  code.value = normalizeRoomCode((e.target as HTMLInputElement).value)
  ;(e.target as HTMLInputElement).value = code.value
  codeError.value = ''
}

function onNameEnter() {
  if (code.value) join()
  else create()
}

onMounted(() => {
  if (!name.value) nameInput.value?.focus()
  else if (!fromInvite) codeInput.value?.focus()
})
</script>

<template>
  <main class="home">

    <section class="card">
      <div class="brand">
        <svg viewBox="0 0 64 64" width="40" height="40" aria-hidden="true">
          <rect width="64" height="64" rx="16" fill="#5865f2" />
          <circle cx="32" cy="32" r="12" fill="#fff" opacity=".9" />
          <g fill="#fff"><circle cx="32" cy="11" r="5" /><circle cx="50.2" cy="42.5" r="5" /><circle cx="13.8" cy="42.5" r="5" /></g>
        </svg>
      </div>
      <h1>{{ fromInvite ? t('home.titleInvite') : t('home.title') }}</h1>
      <p class="sub">
        {{ fromInvite ? t('home.subInvite') : t('home.sub') }}
      </p>

      <div v-if="call.error" class="banner" role="alert">{{ call.error }}</div>
      <div v-if="native.verdict?.ok && native.verdict.newer" class="banner info">
        {{ t('home.updateOut', { newer: native.verdict.newer, current: native.app?.version ?? '' }) }}
        <a :href="newerUrl" target="_blank" rel="noopener">{{ t('home.updateLink') }}</a> {{ t('home.updateAfter') }}
      </div>

      <label class="field">
        <span class="eyebrow" :class="{ bad: nameError }">
          {{ t('home.displayName') }}
          <span v-if="nameError" class="err">- {{ nameError }}</span>
          <span v-else class="req">*</span>
        </span>
        <input
          ref="nameInput"
          v-model="name"
          type="text"
          maxlength="32"
          autocomplete="nickname"
          spellcheck="false"
          :disabled="busy"
          @input="nameError = ''"
          @keydown.enter="onNameEnter"
        />
      </label>

      <button v-if="!fromInvite" type="button" class="option" :disabled="busy" @click="create">
        <span class="option-icon"><Icon name="plus" :size="24" /></span>
        <span class="option-text">
          <strong>{{ t('home.createRoom') }}</strong>
          <small>{{ t('home.createHint') }}</small>
        </span>
        <span v-if="call.joining === 'create'" class="spinner" :aria-label="t('home.creating')" />
        <Icon v-else name="chevron" :size="24" class="chev" />
      </button>

      <div class="join" :class="{ invite: fromInvite }">
        <h3 v-if="!fromInvite">{{ t('home.haveCode') }}</h3>
        <label class="field">
          <span class="eyebrow" :class="{ bad: codeError }">
            {{ t('home.roomCode') }}
            <span v-if="fromInvite && !codeError" class="hint">{{ t('home.fromInvite') }}</span>
            <span v-if="codeError" class="err">- {{ codeError }}</span>
          </span>
          <div class="join-row">
            <input
              ref="codeInput"
              class="code"
              :type="fromInvite && !revealCode ? 'password' : 'text'"
              :value="code"
              placeholder="ABC234"
              :maxlength="CODE_LENGTH"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              :disabled="busy"
              @input="onCode"
              @keydown.enter="join"
            />
            <button type="button" class="btn" :class="fromInvite ? 'primary' : 'secondary'" :disabled="busy" @click="join">
              <span v-if="call.joining === 'join'" class="spinner" :aria-label="t('home.joining')" />
              <span v-else>{{ t('home.join') }}</span>
            </button>
          </div>
        </label>
        <button v-if="fromInvite" type="button" class="link" :disabled="busy" @click="create">
          {{ t('home.makeNew') }}
        </button>
      </div>

      <div v-if="!isNative && downloads.length" class="get-app">
        <span>{{ t('home.getApp') }} <small>{{ t('home.version', { version: appVersion }) }}</small></span>
        <div class="get-app-buttons">
          <a
            v-for="d in downloads"
            :key="d.os"
            class="get-app-button"
            :class="{ mine: d.os === mine }"
            :href="downloadUrl(appVersion, d.file(appVersion))"
            :download="d.file(appVersion)"
            rel="noopener"
          >
            {{ d.label }}
          </a>
        </div>
      </div>

      <footer>
        <span><Icon name="headphones" :size="16" /> {{ t('home.headphones') }}</span>
        <span>{{ t('home.version', { version }) }}<template v-if="native.app"> {{ t('home.appVersion', { version: native.app.version }) }}</template></span>
      </footer>
    </section>
  </main>
</template>

<style scoped>
/* Dark and flat like the rest of the app: the brand colour is for the buttons, not the whole screen. */
.home {
  position: relative;
  height: 100%;
  display: grid;
  /* One column the width of the screen (not of the card: an auto column would grow to 520px and push it off a phone). */
  grid-template-columns: minmax(0, 1fr);
  place-items: center;
  overflow-y: auto;
  padding: calc(40px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(40px + env(safe-area-inset-bottom))
    calc(16px + env(safe-area-inset-left));
  background: var(--bg-tertiary);
}

.card {
  position: relative;
  width: min(520px, 100%);
  padding: 40px;
  border-radius: 8px;
  background: var(--bg-primary);
  box-shadow: var(--elevation-high);
  text-align: center;
}
@media (max-width: 480px) {
  .card {
    padding: 28px 20px;
  }
}
.brand {
  display: flex;
  justify-content: center;
  margin-bottom: 20px;
}
h1 {
  margin: 0 0 10px;
  font-size: 24px;
  line-height: 30px;
  font-weight: 600;
  color: var(--header-primary);
}
.sub {
  margin: 0 0 32px;
  font-size: 16px;
  color: var(--header-secondary);
}
.banner {
  margin: 0 0 24px;
  padding: 10px 12px;
  border-radius: 4px;
  border: 1px solid var(--red);
  background: rgba(242, 63, 67, 0.1);
  color: var(--text-normal);
  font-size: 14px;
  text-align: left;
}
.banner.info {
  border-color: var(--brand);
  background: rgba(88, 101, 242, 0.1);
}
.banner a {
  color: var(--text-link);
}
.field {
  display: block;
  text-align: left;
  margin-bottom: 28px;
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
.eyebrow.bad {
  color: #fa777c;
}
.err {
  font-style: italic;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}
.hint {
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-muted);
}
.req {
  color: var(--red);
  padding-left: 2px;
}
input {
  width: 100%;
  height: 44px;
  padding: 10px 12px;
  border: 0;
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--text-normal);
  font: inherit;
  font-size: 16px;
  outline: none;
}
input:focus-visible {
  outline: none;
}
input:disabled {
  opacity: 0.6;
}
input.code {
  font-family: var(--font-code);
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
input.code::placeholder {
  color: #4e5058;
}

.option {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 18px 16px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--header-primary);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.option:hover:not(:disabled) {
  border-color: var(--bg-accent);
  background: var(--bg-modifier-hover);
}
.option:disabled {
  cursor: progress;
}
.option-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--green);
  color: #fff;
  flex: none;
}
.option-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.option-text strong {
  font-size: 16px;
  font-weight: 600;
}
.option-text small {
  font-size: 14px;
  color: var(--header-secondary);
}
.chev {
  color: var(--interactive-normal);
}

.join {
  margin-top: 32px;
  padding-top: 28px;
  border-top: 1px solid var(--border-strong);
}
.join.invite {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
h3 {
  margin: 0 0 16px;
  font-size: 18px;
  font-weight: 600;
  color: var(--header-primary);
}
.join .field {
  margin-bottom: 0;
}
.join-row {
  display: flex;
  gap: 10px;
}
.btn {
  flex: none;
  min-width: 120px;
  height: 44px;
  padding: 0 16px;
  border: 0;
  border-radius: 3px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  display: grid;
  place-items: center;
  color: #fff;
  transition: background-color 0.17s ease;
}
.btn.primary {
  background: var(--brand);
}
.btn.primary:hover:not(:disabled) {
  background: var(--brand-hover);
}
.btn.secondary {
  background: var(--bg-accent);
}
.btn.secondary:hover:not(:disabled) {
  background: var(--bg-accent-hover);
}
.btn:disabled {
  cursor: progress;
  opacity: 0.8;
}
.link {
  margin-top: 16px;
  border: 0;
  background: none;
  color: var(--text-link);
  font-size: 14px;
  cursor: pointer;
}
.link:hover {
  text-decoration: underline;
}

.get-app {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--border-strong);
  font-size: 13px;
  color: var(--header-secondary);
  text-align: left;
}
.get-app small {
  color: var(--text-muted);
}
.get-app-buttons {
  display: flex;
  gap: 8px;
}
.get-app-button {
  padding: 7px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  color: var(--interactive-normal);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.get-app-button:hover {
  border-color: var(--bg-accent-hover);
  color: var(--interactive-hover);
}
.get-app-button.mine {
  border-color: var(--brand);
  background: var(--brand);
  color: #fff;
}
.get-app-button.mine:hover {
  border-color: var(--brand-hover);
  background: var(--brand-hover);
}
footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  justify-content: space-between;
  margin-top: 32px;
  font-size: 12px;
  color: var(--text-muted);
}
footer span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.spinner {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
