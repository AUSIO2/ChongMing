<script setup lang="ts">
import type { CatalogSubAgent } from '../../flow-map'

defineProps<{
  catalog: CatalogSubAgent[]
  visible: boolean
  selectedAgentName?: string | null
}>()

const emit = defineEmits<{
  select: [agent: CatalogSubAgent]
  confirm: []
  cancel: []
}>()
</script>

<template>
  <div v-if="visible" class="catalog-picker">
    <ul class="catalog">
      <li
        v-for="c in catalog"
        :key="c.agentName"
        :class="{ selected: selectedAgentName === c.agentName }"
        @click="emit('select', c)"
      >
        <div class="cat-label">{{ c.displayLabel }}</div>
        <div class="cat-desc muted">{{ c.description }}</div>
      </li>
    </ul>
    <div class="add-actions">
      <slot name="confirm">
        <button @click="emit('confirm')">确认添加</button>
      </slot>
      <button class="ghost" @click="emit('cancel')">取消</button>
    </div>
  </div>
</template>

<style scoped>
.catalog-picker { display: flex; flex-direction: column; gap: 6px; }
.catalog { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
.catalog li {
  padding: 6px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  cursor: pointer;
}
.catalog li.selected { border-color: var(--accent, #2563eb); background: var(--bg-viewport); }
.cat-label { font-weight: 500; font-size: var(--ui-font-size); }
.cat-desc  { font-size: 12px; color: var(--text-muted); }
.add-actions { display: flex; gap: 6px; }
button.ghost { background: transparent; border: 1px solid var(--border-subtle); padding: 4px 10px; border-radius: 3px; cursor: pointer; }
</style>
