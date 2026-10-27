<script setup lang="ts" generic="T extends string | number">
/** A row of mutually exclusive choices. */
defineProps<{ options: { value: T; label: string }[]; modelValue: T; label?: string }>()
defineEmits<{ 'update:modelValue': [value: T] }>()
</script>

<template>
  <div class="seg-wrap">
    <span v-if="label" class="label">{{ label }}</span>
    <div class="seg" role="radiogroup" :aria-label="label">
      <button
        v-for="o in options"
        :key="String(o.value)"
        type="button"
        role="radio"
        :aria-checked="modelValue === o.value"
        :class="{ active: modelValue === o.value }"
        @click="$emit('update:modelValue', o.value)"
      >
        {{ o.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.seg-wrap {
  padding: 6px 0;
}
.label {
  display: block;
  margin-bottom: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--header-primary);
}
.seg {
  display: grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  padding: 3px;
  gap: 3px;
  border-radius: 6px;
  background: var(--bg-tertiary);
}
.seg button {
  height: 30px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--interactive-normal);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.seg button:hover {
  background: var(--bg-modifier-hover);
  color: var(--interactive-hover);
}
.seg button.active {
  background: var(--brand);
  color: #fff;
}
</style>
