<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useFlowMapStore } from '../../stores/flow-map'
import { NEWS_ROOT_ID, docCanAddSubAgent, docCanEditNode, docCanRemoveNode, labelFormatNodeKind, labelFormatHitl, DATA_PHASE_LABEL } from '../../flow-map'
import SubAgentCatalogPicker from './SubAgentCatalogPicker.vue'
import type {
  MapNode,
  Priority,
  CatalogSubAgent,
} from '../../flow-map'

const store = useFlowMapStore()
const { snapshot, selectedNode, selectedNodeId, catalog, catalogParent, storeReadError } = storeToRefs(store)

const showAddPanel = ref(false)
const draftAgent = ref<CatalogSubAgent | null>(null)

// 若选中变化，同步 catalog（news 节点 或 已持久化 claim）
watch(
  [selectedNodeId, () => snapshot.value?.nodes],
  async ([id]) => {
    showAddPanel.value = false
    draftAgent.value = null
    if (!id) {
      await store.loadRootCatalog()
      return
    }
    const node = snapshot.value?.nodes.find(n => n.id === id)
    if (!node) return
    if (node.kind === 'news') {
      await store.loadRootCatalog()
      return
    }
    if (node.kind === 'claim' && node.dataPhase === 'persisted') {
      await store.loadCatalogFor(id)
    }
  },
)

const isRootAddable = computed(() => {
  const s = snapshot.value
  if (!s) return false
  return docCanAddSubAgent(s, NEWS_ROOT_ID)
})

const isSelectedClaimAddable = computed(() => {
  const s = snapshot.value
  const id = selectedNodeId.value
  if (!s || !id) return false
  return docCanAddSubAgent(s, id)
})

const canEditSelected = computed(() => {
  const s = snapshot.value
  const id = selectedNodeId.value
  if (!s || !id) return false
  return docCanEditNode(s, id)
})

const canRemoveSelected = computed(() => {
  const s = snapshot.value
  const id = selectedNodeId.value
  if (!s || !id) return false
  return docCanRemoveNode(s, id)
})

function beginAddFor(parentNodeId: string) {
  void store.loadCatalogFor(parentNodeId)
  showAddPanel.value = true
  draftAgent.value = null
}

async function confirmAdd(parentNodeId: string) {
  if (!draftAgent.value) return
  await store.addSubAgent(parentNodeId, {
    agentName: draftAgent.value.agentName,
    priority: draftAgent.value.defaultPriority ?? 'medium',
  })
  showAddPanel.value = false
  draftAgent.value = null
}

function agentLabel(agentName: string): string {
  return catalog.value.find(c => c.agentName === agentName)?.displayLabel ?? agentName
}

function agentDescription(agentName: string): string | undefined {
  return catalog.value.find(c => c.agentName === agentName)?.description
}

function isNews(n: MapNode): n is Extract<MapNode, { kind: 'news' }> { return n.kind === 'news' }
function isSubAgent(n: MapNode): n is Extract<MapNode, { kind: 'subAgent' }> { return n.kind === 'subAgent' }
function isClaim(n: MapNode): n is Extract<MapNode, { kind: 'claim' }> { return n.kind === 'claim' }
function isOpinion(n: MapNode): n is Extract<MapNode, { kind: 'opinion' }> { return n.kind === 'opinion' }

async function onNewsContentInput(node: MapNode, ev: Event) {
  if (!isNews(node)) return
  const val = (ev.target as HTMLTextAreaElement).value
  await store.updateNodeParams(node.id, { content: val })
}

async function onSubAgentPriorityChange(node: MapNode, ev: Event) {
  if (!isSubAgent(node)) return
  const val = (ev.target as HTMLSelectElement).value as Priority
  await store.updateNodeParams(node.id, { priority: val })
}

async function onSubAgentHintInput(node: MapNode, ev: Event) {
  if (!isSubAgent(node)) return
  const val = (ev.target as HTMLTextAreaElement).value
  await store.updateNodeParams(node.id, { hint: val })
}

async function onClaimContentInput(node: MapNode, ev: Event) {
  if (!isClaim(node)) return
  const val = (ev.target as HTMLTextAreaElement).value
  await store.updateNodeParams(node.id, { content: val })
}

async function onRemove(node: MapNode) {
  await store.removeNode(node.id)
}
</script>

<template>
  <div class="flow-map-inspector">
    <p v-if="storeReadError" class="error">{{ storeReadError }}</p>

    <!-- 无选中：提示点新闻节点 -->
    <template v-if="!selectedNode">
      <section class="panel">
        <h4>Map 层</h4>
        <p class="muted">未选中节点。请先点「新闻」编辑正文并失焦保存，再点「运行」：系统会加载正文并自动 AI 配槽，暂停后可增删 SubAgent。</p>
      </section>
    </template>

    <!-- 有选中 -->
    <template v-else>
      <section class="panel">
        <div class="head">
          <span class="tag">{{ labelFormatNodeKind(selectedNode) }}</span>
          <span
            v-if="selectedNode.kind === 'claim' || selectedNode.kind === 'opinion'"
            class="phase"
          >
            {{ DATA_PHASE_LABEL[selectedNode.dataPhase] }}
          </span>
          <span
            v-if="selectedNode.kind === 'claim' && !selectedNode.shouldSave"
            class="phase rejected"
          >
            不保存
          </span>
          <span v-if="selectedNode.runtime?.pendingTool" class="tool">
            等待 · {{ labelFormatHitl(selectedNode.runtime.pendingTool, 'pending') }}
          </span>
          <span v-else-if="selectedNode.runtime?.activeTool" class="tool">
            执行 · {{ labelFormatHitl(selectedNode.runtime.activeTool, 'active') }}
          </span>
        </div>

        <!-- News -->
        <div v-if="isNews(selectedNode)" class="form">
          <label>
            正文
            <textarea
              :value="selectedNode.params.content"
              :disabled="!canEditSelected"
              rows="6"
              @change="onNewsContentInput(selectedNode, $event)"
            />
          </label>

          <div class="add-section">
            <button
              class="primary"
              :disabled="!isRootAddable"
              @click="beginAddFor(NEWS_ROOT_ID)"
            >
              添加拆分 SubAgent
            </button>
            <SubAgentCatalogPicker
              :catalog="catalog"
              :visible="showAddPanel && catalogParent === NEWS_ROOT_ID"
              :selected-agent-name="draftAgent?.agentName"
              @select="draftAgent = $event"
              @confirm="confirmAdd(NEWS_ROOT_ID)"
              @cancel="showAddPanel = false"
            >
              <template #confirm>
                <button :disabled="!draftAgent" @click="confirmAdd(NEWS_ROOT_ID)">确认添加</button>
              </template>
            </SubAgentCatalogPicker>
          </div>
        </div>

        <!-- SubAgent：params = MapSubAgentParams（仅 priority / hint 可改） -->
        <div v-else-if="isSubAgent(selectedNode)" class="form">
          <div class="row">
            <span class="k">名称</span><span>{{ agentLabel(selectedNode.params.agentName) }}</span>
          </div>
          <div class="row">
            <span class="k">Agent</span><span>{{ selectedNode.params.agentName }}</span>
          </div>
          <label>
            优先级
            <select
              :value="selectedNode.params.priority"
              :disabled="!canEditSelected"
              @change="onSubAgentPriorityChange(selectedNode, $event)"
            >
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </label>
          <label>
            提示 (hint)
            <textarea
              :value="selectedNode.params.hint ?? ''"
              :disabled="!canEditSelected"
              rows="3"
              placeholder="Route / 人工给该 SubAgent 的提示"
              @change="onSubAgentHintInput(selectedNode, $event)"
            />
          </label>
          <p v-if="agentDescription(selectedNode.params.agentName)" class="muted small">
            {{ agentDescription(selectedNode.params.agentName) }}
          </p>
          <div class="row-actions">
            <button
              class="danger"
              :disabled="!canRemoveSelected"
              @click="onRemove(selectedNode)"
            >
              删除
            </button>
          </div>
        </div>

        <!-- Claim -->
        <div v-else-if="isClaim(selectedNode)" class="form">
          <label>
            内容
            <textarea
              :value="selectedNode.params.content"
              :disabled="!canEditSelected"
              rows="4"
              @change="onClaimContentInput(selectedNode, $event)"
            />
          </label>
          <div v-if="selectedNode.params.sourceAgent" class="row">
            <span class="k">来源</span><span>{{ selectedNode.params.sourceAgent }}</span>
          </div>
          <div v-if="selectedNode.params.category" class="row">
            <span class="k">类别</span><span>{{ selectedNode.params.category }}</span>
          </div>

          <div v-if="selectedNode.dataPhase === 'persisted'" class="add-section">
            <button
              class="primary"
              :disabled="!isSelectedClaimAddable"
              @click="beginAddFor(selectedNode.id)"
            >
              为此事实添加核查 SubAgent
            </button>
            <SubAgentCatalogPicker
              :catalog="catalog"
              :visible="showAddPanel && catalogParent === selectedNode.id"
              :selected-agent-name="draftAgent?.agentName"
              @select="draftAgent = $event"
              @confirm="confirmAdd(selectedNode.id)"
              @cancel="showAddPanel = false"
            >
              <template #confirm>
                <button :disabled="!draftAgent" @click="confirmAdd(selectedNode.id)">确认添加</button>
              </template>
            </SubAgentCatalogPicker>
          </div>
        </div>

        <!-- Opinion：只读投影 -->
        <div v-else-if="isOpinion(selectedNode)" class="form">
          <p class="opinion-body">{{ selectedNode.params.content }}</p>
          <div class="row">
            <span class="k">置信度</span><span>{{ selectedNode.params.confidence }}</span>
          </div>
          <div class="row">
            <span class="k">优先级</span><span>{{ selectedNode.params.priority }}</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.flow-map-inspector {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.panel {
  background: var(--bg-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.head { display: flex; gap: 6px; align-items: center; }
.tag { padding: 1px 6px; border-radius: 3px; background: var(--bg-viewport); border: 1px solid var(--border-subtle); font-size: 12px; }
.phase { color: var(--text-muted); font-size: 12px; }
.phase.rejected { color: var(--text-dim); text-decoration: line-through; }
.tool { color: var(--warning, #d97706); font-size: 12px; }

.form { display: flex; flex-direction: column; gap: var(--space-sm); }
.form label { display: flex; flex-direction: column; gap: 4px; font-size: var(--ui-font-size); color: var(--text-muted); }
.form input, .form select, .form textarea {
  padding: 4px 6px; font: inherit;
  background: var(--bg-viewport);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  color: var(--text);
}
.form textarea { resize: vertical; }

.row { display: flex; justify-content: space-between; font-size: var(--ui-font-size); }
.row .k { color: var(--text-muted); }
.row-actions { display: flex; justify-content: flex-end; }
.muted { color: var(--text-muted); }
.small { font-size: 12px; }
.opinion-body { margin: 0; font-size: var(--ui-font-size); line-height: 1.45; white-space: pre-wrap; }

.add-section { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.add-panel { display: flex; flex-direction: column; gap: 6px; }
.catalog { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
.catalog li {
  padding: 6px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  cursor: pointer;
}
.catalog li.selected { border-color: var(--accent, #2563eb); background: var(--bg-viewport); }
.cat-label { font-weight: 500; font-size: var(--ui-font-size); }
.cat-desc  { font-size: 12px; }
.add-actions { display: flex; gap: 6px; }

button { cursor: pointer; }
button.primary { background: var(--accent, #2563eb); color: #fff; border: none; padding: 4px 10px; border-radius: 3px; }
button.primary[disabled] { opacity: 0.5; cursor: not-allowed; }
button.ghost { background: transparent; border: 1px solid var(--border-subtle); padding: 4px 10px; border-radius: 3px; }
button.danger { background: transparent; border: 1px solid var(--danger, #dc2626); color: var(--danger, #dc2626); padding: 4px 10px; border-radius: 3px; }

.error { color: var(--danger, #dc2626); font-size: var(--ui-font-size); }
</style>
