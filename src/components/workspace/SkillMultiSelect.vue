<script setup lang="ts">
import { computed } from 'vue'
import type { SkillDescriptor } from '../../../electron/api/types'

const props = defineProps<{
  skills: SkillDescriptor[]
  modelValue: string[]
  tavilyConfigured?: boolean
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

function skillNeedsTavily(skill: SkillDescriptor): boolean {
  return skill.requiredKeys.includes('tavilyApiKey')
    && isChecked(skill.id)
    && !props.tavilyConfigured
}
</script>

<template>
  <div class="skill-multi-select">
    <span class="label">技能</span>
    <ul v-if="skills.length" class="skill-list">
      <li v-for="skill in skills" :key="skill.id">
        <label class="skill-row">
          <input
            type="checkbox"
            :checked="isChecked(skill.id)"
            @change="onToggle(skill.id, ($event.target as HTMLInputElement).checked)"
          >
          <span class="skill-body">
            <span class="skill-name">{{ skill.displayLabel }}</span>
            <span class="skill-desc">{{ skill.description }}</span>
            <span v-if="skillNeedsTavily(skill)" class="skill-warn">
              需在「设置」中配置 Tavily API Key
            </span>
          </span>
        </label>
      </li>
    </ul>
    <p v-else class="empty">暂无可用技能</p>
  </div>
</template>

<style scoped>
.skill-multi-select {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-sm);
  font-size: var(--ui-font-size-sm);
}

.label {
  font-weight: 500;
}

.skill-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  max-height: 160px;
  overflow: auto;
}

.skill-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
}

.skill-row input[type="checkbox"] {
  margin-top: 2px;
}

.skill-row:last-child {
  border-bottom: none;
}

.skill-row:hover {
  background: var(--bg-hover);
}

.skill-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.skill-name {
  font-weight: 500;
}

.skill-desc {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.35;
}

.skill-warn {
  color: var(--warning);
  font-size: 11px;
}

.empty {
  color: var(--text-muted);
  padding: 8px 0;
}
</style>
