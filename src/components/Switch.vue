<script setup lang="ts">
/** Discord's toggle switch, with its label. */
defineProps<{ label: string; modelValue: boolean; hint?: string }>()
defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <label class="switch-row">
    <span class="text">
      <span>{{ label }}</span>
      <small v-if="hint">{{ hint }}</small>
    </span>
    <span class="switch" :class="{ on: modelValue }">
      <input
        type="checkbox"
        class="sr-only"
        :checked="modelValue"
        @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <span class="knob" />
    </span>
  </label>
</template>

<style scoped>
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--header-primary);
  cursor: pointer;
}
.text {
  display: flex;
  flex-direction: column;
}
small {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-muted);
}
.switch {
  position: relative;
  width: 40px;
  height: 24px;
  border-radius: 14px;
  background: #80848e;
  transition: background-color 0.2s ease;
  flex: none;
}
.switch.on {
  background: var(--green);
}
.knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s ease;
}
.switch.on .knob {
  transform: translateX(16px);
}
.switch:has(input:focus-visible) {
  outline: 2px solid var(--text-link);
  outline-offset: 2px;
}
</style>
