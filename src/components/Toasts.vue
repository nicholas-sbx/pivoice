<script setup lang="ts">
import { call, dismissToast } from '../call'
import Icon from './Icon.vue'
</script>

<template>
  <div class="toasts" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in call.toasts" :key="t.id" class="toast" :class="t.kind" @click="dismissToast(t.id)">
        <Icon v-if="t.kind === 'success'" name="check" :size="18" />
        <span>{{ t.text }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 50;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 8px;
  background: var(--bg-floating);
  color: var(--text-normal);
  font-size: 14px;
  font-weight: 500;
  box-shadow: var(--elevation-high), var(--elevation-stroke);
  max-width: 480px;
}
.toast.success svg {
  color: var(--green);
}
.toast.error {
  background: var(--red-strong);
  color: #fff;
}
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
