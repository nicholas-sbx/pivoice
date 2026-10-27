<script setup lang="ts">
/** A labelled slider with its value shown, Discord-style. */
const props = withDefaults(
  defineProps<{ label: string; modelValue: number; min: number; max: number; step?: number; unit?: string; hint?: string; digits?: number }>(),
  { step: 1, unit: '', hint: '', digits: 0 }
)
defineEmits<{ 'update:modelValue': [value: number] }>()
const fill = () => ((props.modelValue - props.min) / (props.max - props.min)) * 100 + '%'
</script>

<template>
  <label class="slider">
    <span class="top">
      <span class="label">{{ label }}</span>
      <span class="value">{{ modelValue.toFixed(digits) }}{{ unit }}</span>
    </span>
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :style="{ '--fill': fill() }"
      @input="$emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    />
    <small v-if="hint">{{ hint }}</small>
  </label>
</template>

<style scoped>
.slider {
  display: block;
  padding: 6px 0;
}
.top {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 14px;
  font-weight: 500;
}
.label {
  color: var(--header-primary);
}
.value {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
small {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: linear-gradient(to right, var(--brand) var(--fill), var(--bg-accent) var(--fill));
  cursor: pointer;
}
input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 22px;
  border-radius: 3px;
  background: #fff;
  border: 1px solid #dcddde;
}
input[type='range']::-moz-range-thumb {
  width: 10px;
  height: 22px;
  border-radius: 3px;
  background: #fff;
  border: 1px solid #dcddde;
}
</style>
