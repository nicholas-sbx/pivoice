<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  call,
  copyCode,
  copyInvite,
  leaveCall,
  seating,
  toggleDeafen,
  toggleMute,
  updatePrefs,
  toggleShowCode,
  toggleSpatial
} from '../call'
import ControlButton from '../components/ControlButton.vue'
import DisplayPanel from '../components/DisplayPanel.vue'
import Icon from '../components/Icon.vue'
import OverlayTable from '../components/OverlayTable.vue'
import PeopleGrid from '../components/PeopleGrid.vue'
import RoundTable from '../components/RoundTable.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import UserMenu from '../components/UserMenu.vue'
import { isNative } from '../native/bridge'
import { useCompact } from '../lib/viewport'
import { vSnap } from '../lib/snap'
import { closePip, pipRoot, pipSupported, pipWindow, togglePip } from '../pip'
import { overlayError, overlaySupported } from '../native/overlay'

const settingsOpen = ref(false)
const displayOpen = ref(false)
const menu = ref<{ id: string; x: number; y: number } | null>(null)

// On a phone, the table only while seats mean something (spatial audio); otherwise a list of tiles.
const compact = useCompact()
const asList = computed(() => compact.value && call.prefs.spatial === 'off')

const selfMuted = computed(() => call.muted || call.deafened || !!call.micProblem)
const present = computed(() => call.members.filter(m => !m.away).length || 1)
const spatialLabel = computed(() =>
  call.prefs.spatial === 'off'
    ? 'Spatial Audio: Off'
    : call.prefs.spatial === 'hrtf'
      ? `Spatial Audio: ${isNative ? 'Binaural' : 'HRTF'}`
      : 'Spatial Audio: Stereo'
)
/** The app's overlay, on or off: it stays that way for later calls too. */
function toggleOverlay() {
  updatePrefs({ overlay: { ...call.prefs.overlay, on: !call.prefs.overlay.on } })
}
const overlayOn = computed(() => call.prefs.overlay.on && !overlayError.value)

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const mod = isMac ? '⌘⇧' : 'Ctrl+Shift+'

function onKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return
  const k = e.key.toLowerCase()
  if (k === 'm') {
    e.preventDefault()
    toggleMute()
  } else if (k === 'd') {
    e.preventDefault()
    toggleDeafen()
  }
}

onMounted(() => addEventListener('keydown', onKey))
// The pop-out is a window of its own, with its own key events.
watch(
  pipWindow,
  (win, old) => {
    old?.removeEventListener('keydown', onKey)
    win?.addEventListener('keydown', onKey)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  removeEventListener('keydown', onKey)
  pipWindow.value?.removeEventListener('keydown', onKey)
  closePip()
})
</script>

<template>
  <div class="room">
    <header class="bar">
      <div class="left">
        <Icon name="speaker" :size="24" class="muted-icon" />
        <h1>Voice Room</h1>
        <div class="code" :class="{ hidden: !call.prefs.showCode }">
          <span class="code-text" :aria-label="call.prefs.showCode ? `Room code ${call.code}` : 'Room code hidden'">
            {{ call.prefs.showCode ? call.code : '••••••' }}
          </span>
          <button
            type="button"
            class="code-btn"
            :title="call.prefs.showCode ? 'Hide code' : 'Show code'"
            :aria-label="call.prefs.showCode ? 'Hide room code' : 'Show room code'"
            @click="toggleShowCode"
          >
            <Icon name="eye" :size="16" :slash="call.prefs.showCode" />
          </button>
          <button type="button" class="code-btn" title="Copy room code" aria-label="Copy room code" @click="copyCode">
            <Icon name="copy" :size="14" />
          </button>
        </div>
        <div class="divider" />
        <div class="status" :class="call.status" :title="call.status === 'connected' ? 'Voice Connected' : 'Reconnecting…'">
          <Icon name="signal" :size="16" />
          <span class="status-text">{{ call.status === 'connected' ? 'Voice Connected' : 'Reconnecting…' }}</span>
        </div>
      </div>
      <div class="right">
        <div class="people" :title="`${present} in the call`">
          <Icon name="people" :size="20" />
          <span>{{ present }}</span>
        </div>
        <button
          v-if="pipSupported"
          type="button"
          class="bar-btn"
          :class="{ active: !!pipRoot }"
          :title="pipRoot ? 'Close pop-out table' : 'Pop out table'"
          :aria-label="pipRoot ? 'Close pop-out table' : 'Pop out table'"
          :aria-pressed="!!pipRoot"
          @click="togglePip"
        >
          <Icon name="pip" :size="20" />
        </button>
        <button
          v-else-if="overlaySupported"
          type="button"
          class="bar-btn"
          :class="{ active: overlayOn }"
          :title="overlayOn ? 'Hide overlay' : 'Show overlay'"
          :aria-label="overlayOn ? 'Hide overlay' : 'Show overlay'"
          :aria-pressed="overlayOn"
          @click="toggleOverlay"
        >
          <Icon name="pip" :size="20" />
        </button>
        <div class="display-anchor">
          <button
            type="button"
            class="bar-btn"
            :class="{ active: displayOpen }"
            title="Display settings"
            aria-label="Display settings"
            data-display-toggle
            @click="displayOpen = !displayOpen"
          >
            <Icon name="gear" :size="20" />
          </button>
          <DisplayPanel v-if="displayOpen" @close="displayOpen = false" />
        </div>
        <button type="button" class="invite" title="Copy invite link" @click="copyInvite">
          <Icon name="link" :size="18" />
          <span class="invite-text">Copy Invite</span>
        </button>
      </div>
    </header>

    <main class="stage">
      <PeopleGrid
        v-if="asList"
        :members="call.members"
        :self-id="call.selfId"
        :speaking="call.speaking"
        :audible="call.audible"
        :self-muted="selfMuted"
        :self-deafened="call.deafened"
        :silenced="call.silenced"
        :links="call.links"
        :show-ping="call.prefs.showPing"
        :show-route="call.prefs.showRoute"
        @menu="(id, x, y) => (menu = { id, x, y })"
      />
      <RoundTable
        v-else
        :members="call.members"
        :self-id="call.selfId"
        :speaking="call.speaking"
        :audible="call.audible"
        :self-muted="selfMuted"
        :self-deafened="call.deafened"
        :code="call.prefs.showCode ? call.code : ''"
        :silenced="call.silenced"
        :links="call.links"
        :show-ping="call.prefs.showPing"
        :show-route="call.prefs.showRoute"
        @menu="(id, x, y) => (menu = { id, x, y })"
      />

      <div v-snap class="pill" role="toolbar" aria-label="Call controls">
        <ControlButton
          icon="mic"
          :label="selfMuted ? 'Unmute' : 'Mute'"
          :off="selfMuted"
          :shortcut="mod + 'M'"
          @click="toggleMute"
        />
        <ControlButton
          icon="headphones"
          :label="call.deafened ? 'Undeafen' : 'Deafen'"
          :off="call.deafened"
          :shortcut="mod + 'D'"
          @click="toggleDeafen"
        />
        <ControlButton icon="spatial" :label="spatialLabel" :on="call.prefs.spatial !== 'off'" @click="toggleSpatial" />
        <div class="settings-anchor">
          <ControlButton
            icon="gear"
            label="Voice Settings"
            :on="settingsOpen"
            data-settings-toggle
            @click="settingsOpen = !settingsOpen"
          />
          <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
        </div>
        <div class="sep" />
        <ControlButton icon="hangup" label="Disconnect" danger @click="leaveCall" />
      </div>
    </main>

    <!-- The pop-out window's page is another document, but the same JavaScript: same props, same state. -->
    <Teleport v-if="pipRoot" :to="pipRoot">
      <OverlayTable
        :seating="seating"
        :members="call.members"
        :self-id="call.selfId"
        :speaking="call.speaking"
        :audible="call.audible"
        :self-muted="selfMuted"
        :self-deafened="call.deafened"
        :silenced="call.silenced"
        controls
        :spatial="call.prefs.spatial !== 'off'"
        :spatial-label="spatialLabel"
        @toggle-mute="toggleMute"
        @toggle-deafen="toggleDeafen"
        @toggle-spatial="toggleSpatial"
        @leave="leaveCall"
      />
    </Teleport>

    <UserMenu v-if="menu" :id="menu.id" :key="menu.id + menu.x + menu.y" :x="menu.x" :y="menu.y" @close="menu = null" />
  </div>
</template>

<style scoped>
.room {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-stage);
}
.bar {
  flex: none;
  height: calc(52px + env(safe-area-inset-top));
  padding: env(safe-area-inset-top) calc(12px + env(safe-area-inset-right)) 0 calc(20px + env(safe-area-inset-left));
  gap: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-primary);
  box-shadow: var(--elevation-low);
  position: relative;
  z-index: 2;
}
.left,
.right {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.right {
  flex: none;
  gap: 10px;
}
.muted-icon {
  color: var(--text-muted);
}
h1 {
  margin: 0;
  font-size: 16px;
  line-height: 20px;
  font-weight: 600;
  color: var(--header-primary);
  white-space: nowrap;
}
.code {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 26px;
  padding: 0 2px 0 10px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--header-secondary);
}
.code-text {
  min-width: 6.6em;
  margin-right: 4px;
  font-family: var(--font-code);
  font-size: 13px;
  letter-spacing: 0.12em;
  user-select: text;
}
.code.hidden .code-text {
  user-select: none;
  letter-spacing: 0.2em;
}
.code-btn {
  width: 24px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 3px;
  background: none;
  color: var(--interactive-normal);
  cursor: pointer;
}
.code-btn:hover {
  background: var(--bg-modifier-hover);
  color: var(--interactive-hover);
}
.divider {
  flex: none;
  width: 1px;
  height: 24px;
  margin: 0 4px;
  background: var(--bg-accent);
}
.status {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.status-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.status.connected {
  color: var(--green);
}
.status.reconnecting,
.status.connecting {
  color: var(--yellow);
}
.display-anchor {
  position: relative;
}
.bar-btn {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--interactive-normal);
  cursor: pointer;
}
.bar-btn:hover,
.bar-btn.active {
  color: var(--interactive-active);
  background: var(--bg-modifier-hover);
}
.people {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  color: var(--interactive-normal);
  font-size: 14px;
  font-weight: 600;
}
.invite {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 16px;
  white-space: nowrap;
  border: 0;
  border-radius: 3px;
  background: var(--brand);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.17s ease;
}
.invite:hover {
  background: var(--brand-hover);
}
/* Narrower windows: the words go before anything gets squeezed, icons and the code stay. */
@media (max-width: 760px) {
  .bar h1,
  .bar .muted-icon {
    display: none;
  }
  .bar {
    padding-left: calc(12px + env(safe-area-inset-left));
  }
}
@media (max-width: 600px) {
  .status-text,
  .invite-text {
    display: none;
  }
  .invite {
    width: 34px;
    padding: 0;
    justify-content: center;
  }
}
@media (max-width: 380px) {
  .people,
  .divider {
    display: none;
  }
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  background: var(--bg-stage);
}

.pill {
  position: absolute;
  left: 0;
  right: 0;
  margin: 0 auto;
  width: max-content;
  bottom: calc(24px + env(safe-area-inset-bottom));
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 40px;
  background: var(--bg-floating);
  box-shadow: 0 0 0 1px var(--border-subtle);
  z-index: 5;
}
.settings-anchor {
  position: relative;
}
@media (max-width: 380px) {
  .pill {
    gap: 6px;
    padding: 6px;
  }
}
.sep {
  width: 1px;
  height: 32px;
  margin: 0 4px;
  background: var(--bg-accent);
}
</style>
