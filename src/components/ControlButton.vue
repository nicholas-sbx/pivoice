<script setup lang="ts">
import Icon from './Icon.vue'
import type { IconName } from './icons'

withDefaults(
  defineProps<{
    icon: IconName
    label: string
    /** Struck through in red: mic muted, deafened. */
    off?: boolean
    /** Lit up in blurple: a mode that's on. */
    on?: boolean
    danger?: boolean
    shortcut?: string
  }>(),
  { off: false, on: false, danger: false, shortcut: '' }
)
defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <button
    type="button"
    class="ctl"
    :class="{ off, on, danger }"
    :aria-label="label"
    :aria-pressed="off || on ? 'true' : undefined"
    @click="$emit('click', $event)"
  >
    <Icon :name="icon" :size="danger ? 26 : 22" :slash="off" />
    <span class="tip" role="tooltip">
      {{ label }}
      <kbd v-if="shortcut">{{ shortcut }}</kbd>
    </span>
  </button>
</template>

<style scoped>
.ctl {
  position: relative;
  width: 52px;
  height: 52px;
  border: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: var(--bg-secondary);
  color: var(--interactive-hover);
  transition:
    background-color 0.12s ease,
    color 0.12s ease,
    transform 0.12s ease;
}
.ctl:hover {
  background: var(--bg-accent);
  color: var(--interactive-active);
}
.ctl:active {
  transform: scale(0.95);
}
.ctl.off {
  background: #f2f3f5;
  color: #313338;
}
.ctl.off:hover {
  background: #dbdee1;
}
.ctl.on {
  background: var(--brand);
  color: #fff;
}
.ctl.on:hover {
  background: var(--brand-hover);
}
.ctl.danger {
  width: 68px;
  border-radius: 26px;
  background: var(--red-strong);
  color: #fff;
}
.ctl.danger:hover {
  background: var(--red-hover);
}

.tip {
  position: absolute;
  bottom: calc(100% + 12px);
  left: 50%;
  transform: translate(-50%, 4px);
  padding: 6px 10px;
  border-radius: 5px;
  background: var(--bg-floating);
  color: var(--text-normal);
  font-size: 14px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  box-shadow: var(--elevation-high);
  pointer-events: none;
  opacity: 0;
  transition:
    opacity 0.1s ease,
    transform 0.1s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}
.tip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  margin-left: -5px;
  border: 5px solid transparent;
  border-top-color: var(--bg-floating);
}
.ctl:hover .tip,
.ctl:focus-visible .tip {
  opacity: 1;
  transform: translate(-50%, 0);
}
kbd {
  font-family: var(--font);
  font-size: 12px;
  color: var(--text-muted);
}
</style>
