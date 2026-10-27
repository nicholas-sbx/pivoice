<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  call,
  copyCode,
  copyInvite,
  getEngine,
  leaveCall,
  toggleDeafen,
  toggleMute,
  toggleShowCode,
  toggleSpatial
} from '../call'
import ControlButton from '../components/ControlButton.vue'
import Icon from '../components/Icon.vue'
import RoundTable from '../components/RoundTable.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import UserMenu from '../components/UserMenu.vue'

const settingsOpen = ref(false)
const menu = ref<{ id: string; x: number; y: number } | null>(null)

const selfMuted = computed(() => call.muted || call.deafened || !!call.micProblem)
const present = computed(() => call.members.filter(m => !m.away).length || 1)
const spatialLabel = computed(() =>
  call.prefs.spatial === 'off'
    ? 'Spatial Audio: Off'
    : call.prefs.spatial === 'hrtf'
      ? 'Spatial Audio: HRTF'
      : 'Spatial Audio: Stereo'
)
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const mod = isMac ? '⌘⇧' : 'Ctrl+Shift+'

function onAngle(id: string, angle: number) {
  getEngine()?.setAngle(id, angle)
}

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
onBeforeUnmount(() => removeEventListener('keydown', onKey))
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
        <div class="status" :class="call.status">
          <Icon name="signal" :size="16" />
          <span>{{ call.status === 'connected' ? 'Voice Connected' : 'Reconnecting…' }}</span>
        </div>
      </div>
      <div class="right">
        <div class="people" :title="`${present} in the call`">
          <Icon name="people" :size="20" />
          <span>{{ present }}</span>
        </div>
        <button type="button" class="invite" @click="copyInvite">
          <Icon name="link" :size="18" />
          Copy Invite
        </button>
      </div>
    </header>

    <main class="stage">
      <RoundTable
        :members="call.members"
        :self-id="call.selfId"
        :speaking="call.speaking"
        :self-muted="selfMuted"
        :self-deafened="call.deafened"
        :code="call.prefs.showCode ? call.code : ''"
        :silenced="call.silenced"
        @angle="onAngle"
        @menu="(id, x, y) => (menu = { id, x, y })"
      />

      <div class="pill" role="toolbar" aria-label="Call controls">
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
  height: 48px;
  padding: 0 8px 0 16px;
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
  gap: 8px;
  min-width: 0;
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
  width: 1px;
  height: 24px;
  margin: 0 8px;
  background: var(--bg-accent);
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.status.connected {
  color: var(--green);
}
.status.reconnecting,
.status.connecting {
  color: var(--yellow);
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
  gap: 6px;
  height: 32px;
  padding: 0 14px;
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

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  background:
    radial-gradient(ellipse at 50% 45%, rgba(88, 101, 242, 0.06), transparent 60%),
    var(--bg-stage);
}

.pill {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 40px;
  background: var(--bg-floating);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.5),
    0 0 0 1px var(--border-subtle);
  z-index: 5;
}
.settings-anchor {
  position: relative;
}
.sep {
  width: 1px;
  height: 32px;
  margin: 0 4px;
  background: var(--bg-accent);
}
</style>
