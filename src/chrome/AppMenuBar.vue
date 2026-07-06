<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useFlowMapStore } from '../stores/flow-map'
import { RUN_PHASE_LABEL } from '../flow-map'
import { CHROME_MENUS } from './menu-registry'
import AppMenuDropdown from './AppMenuDropdown.vue'
import {
  chromeReadOpenMenu,
  chromeReadToast,
  chromeToggleMenu,
  useChromeMenuDismiss,
} from './use-chrome-menu'
import type { ChromeMenuId } from './types'

const flowMap = useFlowMapStore()
const { runPhase } = storeToRefs(flowMap)

const openMenuId = chromeReadOpenMenu()
const toastMessage = chromeReadToast()

useChromeMenuDismiss()

const statusText = computed(() => RUN_PHASE_LABEL[runPhase.value])

function isOpen(id: ChromeMenuId): boolean {
  return openMenuId.value === id
}

function onMenuPointerDown(id: ChromeMenuId) {
  chromeToggleMenu(id)
}
</script>

<template>
  <div class="chrome-menu-bar">
    <div class="chrome-menu-left">
      <h1 class="brand">重明</h1>
      <nav class="menus" aria-label="应用菜单">
        <div
          v-for="menu in CHROME_MENUS"
          :key="menu.id"
          class="menu-wrap"
        >
          <button
            type="button"
            class="menu-trigger"
            :class="{ open: isOpen(menu.id) }"
            :aria-expanded="isOpen(menu.id)"
            @pointerdown.stop.prevent="onMenuPointerDown(menu.id)"
          >
            {{ menu.label }}
          </button>
          <AppMenuDropdown
            v-if="isOpen(menu.id)"
            :items="menu.items"
          />
        </div>
      </nav>
    </div>

    <div class="status-area">
      <span class="status-dot" :class="[runPhase]" />
      <span class="status-text">{{ statusText }}</span>
    </div>

    <Teleport to="body">
      <div v-if="toastMessage" class="chrome-toast" role="status">
        {{ toastMessage }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.chrome-menu-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 var(--space-md);
  -webkit-app-region: no-drag;
  border-bottom: 1px solid var(--border-subtle);
}

.chrome-menu-left {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  min-width: 0;
}

.brand {
  font-size: var(--ui-font-size-lg);
  font-weight: 700;
  letter-spacing: 0.02em;
  margin: 0;
  flex-shrink: 0;
}

.menus {
  display: flex;
  align-items: center;
  gap: 2px;
}

.menu-wrap {
  position: relative;
}

.menu-trigger {
  padding: 2px 8px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text);
  font-size: var(--ui-font-size);
  cursor: pointer;
}

.menu-trigger:hover,
.menu-trigger.open {
  background: var(--bg-hover);
}

.status-area {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: var(--ui-font-size);
  color: var(--text-muted);
  flex-shrink: 0;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
}

.status-dot.running,
.status-dot.interrupted { background: var(--warning); }
.status-dot.completed,
.status-dot.idle { background: var(--text-dim); }
.status-dot.error { background: var(--danger); }
.status-dot.running { background: var(--accent); }
</style>

<style>
.chrome-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10001;
  padding: 8px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-muted);
  font-size: var(--ui-font-size-md);
  box-shadow: 0 4px 12px rgb(0 0 0 / 12%);
  pointer-events: none;
}
</style>
