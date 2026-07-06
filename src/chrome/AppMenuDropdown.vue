<script setup lang="ts">
import type { ChromeMenuItem } from './types'
import { chromeRunAction } from './use-chrome-menu'

defineProps<{
  items: ChromeMenuItem[]
}>()

function onPick(item: ChromeMenuItem) {
  if (item.separator || item.enabled === false) return
  chromeRunAction(item.action)
}
</script>

<template>
  <ul class="chrome-menu-dropdown" role="menu" @pointerdown.stop>
    <template v-for="item in items" :key="item.id">
      <li v-if="item.separator" class="sep" role="separator" />
      <li v-else role="none">
        <button
          type="button"
          class="item"
          role="menuitem"
          :disabled="item.enabled === false"
          :title="item.hint"
          @click="onPick(item)"
        >
          <span class="label">{{ item.label }}</span>
        </button>
      </li>
    </template>
  </ul>
</template>

<style scoped>
.chrome-menu-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 1000;
  min-width: 168px;
  margin: 2px 0 0;
  padding: 4px 0;
  list-style: none;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgb(0 0 0 / 12%);
}

.sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--border-subtle);
}

.item {
  display: block;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--ui-font-size);
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.item:hover:not(:disabled) {
  background: var(--bg-hover);
}

.item:disabled {
  color: var(--text-dim);
  cursor: not-allowed;
}

.label {
  display: block;
}
</style>
