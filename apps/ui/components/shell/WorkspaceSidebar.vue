<!-- 工作区侧栏：呈现导航和可用操作，通过事件把用户意图交给页面。 -->
<script setup lang="ts">
import type { GraphMapSummary } from '../../../../contracts/graph-api'
import type { Role, WorkspaceSummary } from '../../../../contracts/control'

withDefaults(defineProps<{
  workspaces: readonly WorkspaceSummary[]
  maps: readonly GraphMapSummary[]
  workspaceId: string | null
  mapId: string | null
  role: Role | null
  canEdit: boolean
  busy: boolean
  evidenceActive?: boolean
  evidenceAvailable?: boolean
}>(), { evidenceActive: false, evidenceAvailable: false })

const emit = defineEmits<{
  selectWorkspace: [workspaceId: string]
  openMap: [mapId: string]
  createWorkspace: []
  createMap: []
  openEvidence: []
}>()
</script>

<template>
  <div class="workspace-sidebar" aria-label="工作区与数据图导航">
    <div class="workspace-picker">
      <label class="sr-only" for="workspace-sidebar-select">当前工作区</label>
      <select id="workspace-sidebar-select" :value="workspaceId ?? ''"
        aria-label="当前工作区" @change="emit('selectWorkspace', ($event.target as HTMLSelectElement).value)">
        <option disabled value="">选择工作区</option>
        <option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">
          {{ workspace.name }}
        </option>
      </select>
      <div v-if="role" class="workspace-meta">
        <span>{{ ({ owner: '所有者', editor: '编辑者', viewer: '只读成员' })[role] }}</span>
        <span>{{ maps.length }} 张数据图</span>
      </div>
    </div>

    <button v-if="workspaceId" class="map-item library-item" :class="{ selected: evidenceActive }"
      :aria-current="evidenceActive ? 'page' : undefined" type="button" :disabled="!evidenceAvailable" @click="emit('openEvidence')">
      <span class="map-name">证据库</span><small>{{ evidenceAvailable ? '已收录的固定陈述' : '当前服务未提供证据库' }}</small>
    </button>

    <div class="sidebar-heading">
      <h2>数据图</h2>
      <button class="icon-action" type="button" aria-label="创建数据图"
        :disabled="!canEdit || busy" @click="emit('createMap')">＋</button>
    </div>

    <nav v-if="maps.length" class="map-list" aria-label="当前工作区的数据图">
      <button v-for="map in maps" :key="map.id" class="map-item"
        :class="{ selected: map.id === mapId }" :aria-current="map.id === mapId ? 'page' : undefined"
        type="button" @click="emit('openMap', map.id)">
        <span class="map-name">{{ map.name }}</span>
        <small>{{ Object.keys(map.typeCounts).length }} 种类型 · {{ map.nodeCount }} 个节点</small>
      </button>
    </nav>
    <div v-else class="sidebar-empty">
      <p v-if="!workspaces.length">还没有工作区。</p>
      <p v-else-if="!workspaceId">请选择一个工作区。</p>
      <p v-else>当前工作区还没有数据图。</p>
      <button v-if="!workspaces.length" class="primary" type="button" :disabled="busy"
        @click="emit('createWorkspace')">创建工作区</button>
      <button v-else-if="canEdit" class="primary" type="button" :disabled="busy"
        @click="emit('createMap')">创建第一张数据图</button>
      <p v-else-if="role === 'viewer'">等待编辑者创建数据图。</p>
    </div>
  </div>
</template>

<style scoped>
/* 把工作区选择与 Map 列表安排在可滚动的纸色侧栏中。 */
.workspace-sidebar { display: flex; flex-direction: column; width: 100%; min-width: 0; height: 100%; overflow: hidden; background: var(--bg-panel); }
.workspace-picker { padding: 16px; border-bottom: 1px solid var(--border); }
.workspace-picker select { padding: 10px 12px; border-radius: var(--radius); font-size: 14px; }
.workspace-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 9px; color: var(--text-muted); font-size: 12px; }
.library-item { width:calc(100% - 20px); margin:10px 10px 0; flex-shrink:0; }
.sidebar-heading { display: flex; align-items: center; justify-content: space-between; padding: 15px 18px 9px; }
.sidebar-heading h2 { color: var(--text); font-family:var(--content-font); font-size: 15px; font-weight: 600; }
.icon-action { width: 34px; min-height: 34px; padding: 0; border-color: var(--border); background: var(--bg-input); color: var(--text-muted); }
.map-list { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 5px; overflow: auto; padding: 4px 10px 18px; }
.map-item { position: relative; display: flex; width: 100%; min-width: 0; flex-direction: column; align-items: flex-start; gap: 5px; padding: 12px 12px 12px 15px; border-color: transparent; background: transparent; text-align: left; }
.map-item.selected { border-color: transparent; background: var(--bg-nav-selected); box-shadow: none; }
.map-item.selected::before { position: absolute; top: 50%; left: 0; width: 3px; height: 20px; border-radius: 2px; background: var(--accent); content: ''; transform: translateY(-50%); }
.map-name { overflow: hidden; max-width: 100%; color: var(--text); font-family:var(--content-font); font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.map-item small { color: var(--text-muted); font-size: 12px; }
.sidebar-empty { display: grid; gap: 12px; padding: 20px 16px; color: var(--text-muted); font-size: 14px; line-height: 1.7; }
.sidebar-empty .primary { justify-self: start; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
</style>
