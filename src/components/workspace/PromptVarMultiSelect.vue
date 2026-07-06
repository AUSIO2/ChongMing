<script setup lang="ts">
import { computed } from 'vue'
import type { PromptVarDescriptor } from '../../../electron/api/types'

const props = defineProps<{
  slots: PromptVarDescriptor[]
  modelValue: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const selected = computed({
  get: () => props.modelValue,
  set: (value: string[]) => emit('update:modelValue', value),
})

function isChecked(id: string): boolean {
  return selected.value.includes(id)
}

function onToggle(id: string, checked: boolean) {
  const next = new Set(selected.value)
  if (checked) next.add(id)
  else next.delete(id)
  selected.value = [...next]
}
</script>

<template>
  <div class="prompt-var-multi-select">
    <span class="label">注入参数</span>
    <ul v-if="slots.length" class="slot-list">
      <li v-for="slot in slots" :key="slot.id">
        <label class="slot-row">
          <input
            type="checkbox"
            :checked="isChecked(slot.id)"
            @change="onToggle(slot.id, ($event.target as HTMLInputElement).checked)"
          >
          <span class="slot-body">
            <span class="slot-name">{{ slot.label }}</span>
            <span class="slot-desc">{{ slot.description ?? slot.placeholder }}</span>
          </span>
        </label>
      </li>
    </ul>
    <p v-else class="empty">暂无可用注入块</p>
  </div>
</template>

<style scoped>
.prompt-var-multi-select {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-sm);
  font-size: var(--ui-font-size-sm);
}

.label {
  font-weight: 500;
}

.slot-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  max-height: 180px;
  overflow: auto;
}

.slot-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
}

.slot-row input[type="checkbox"] {
  margin-top: 2px;
}

.slot-row:last-child {
  border-bottom: none;
}

.slot-row:hover {
  background: var(--bg-hover);
}

.slot-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.slot-name {
  font-weight: 500;
}

.slot-desc {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.35;
  font-family: ui-monospace, monospace;
}

.empty {
  color: var(--text-muted);
  padding: 8px 0;
}
</style>
