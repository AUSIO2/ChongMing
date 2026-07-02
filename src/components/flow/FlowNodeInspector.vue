<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import PanelRegion from '../shell/PanelRegion.vue'
import { useFlowHitlEdit } from '../../composables/useFlowHitlEdit'
import { useFlowNodeParams } from '../../composables/useFlowNodeParams'
import { useSubAgentCatalog } from '../../composables/useSubAgentCatalog'
import { useWorkspaceStore } from '../../stores/workspace'
import { findClaimIndex, resolveClaimFromNode } from '../../utils/claimMatch'
import { parseRouteIndexFromNodeId, splitWorkerNodeId, subAgentNodeId } from '../../utils/routeNodeId'
import type { Priority } from '../../../electron/api/types'

const store = useWorkspaceStore()
const {
  selectedFlowNode,
  graphState,
  graphType,
  currentNews,
  selectedClaimId,
  isInterrupted,
  nextNode,
  flowPhase,
  isSplitCommitStep,
  isVerifyCommitStep,
  commitMergedClaims,
} = storeToRefs(store)

const { sections, title } = useFlowNodeParams(
  selectedFlowNode,
  graphState,
  graphType,
  currentNews,
  selectedClaimId,
)

const {
  priorities,
  scores,
  routeInstructions,
  mergedClaims,
  finalScore,
  finalReason,
  removeRoute,
  addClaim,
  removeClaim,
  restoreClaim,
  buildPatch,
  undo,
  canUndo,
  isSplitState,
} = useFlowHitlEdit(graphState, graphType, nextNode)

const { catalog, agentsForRouteIndex } = useSubAgentCatalog(
  graphType,
  flowPhase,
  routeInstructions,
)

const editableRouteAgents = computed(() => {
  const idx = selectedRouteIndex.value
  return idx >= 0 ? agentsForRouteIndex(idx) : []
})

const canAddRoute = computed(() => catalog.value.length > 0)

watch(
  mergedClaims,
  (claims) => {
    if (isSplitCommitStep.value) {
      store.setCommitMergedClaims(claims.map(c => ({ ...c })))
    }
  },
  { deep: true },
)

const isRouteConfigPhase = computed(
  () => flowPhase.value === 'awaitingSplit' || flowPhase.value === 'awaitingVerifyRoute',
)

const showCanvasAddRoute = computed(
  () => isRouteConfigPhase.value && !selectedFlowNode.value,
)

const newRouteDraft = ref<{ agentName: string; priority: Priority; hint: string }>({
  agentName: '',
  priority: 'medium',
  hint: '',
})

watch(showCanvasAddRoute, (active) => {
  if (active) {
    newRouteDraft.value = {
      agentName: catalog.value[0]?.name ?? '',
      priority: 'medium',
      hint: '',
    }
  }
})

function submitAddRoute() {
  if (!newRouteDraft.value.agentName.trim()) return
  store.addRouteInstruction({ ...newRouteDraft.value })
  newRouteDraft.value = {
    agentName: catalog.value[0]?.name ?? '',
    priority: 'medium',
    hint: '',
  }
}

function onWorkerAgentChange(agentName: string) {
  const idx = selectedRouteIndex.value
  if (idx < 0) return
  routeInstructions.value[idx].agentName = agentName
  store.syncRouteInstructions(routeInstructions.value)
  const nodeId = graphType.value === 'verify'
    ? subAgentNodeId(idx)
    : splitWorkerNodeId(idx)
  store.selectFlowNode(nodeId)
}

const showWorkerRouteEdit = computed(() => {
  if (!isRouteConfigPhase.value || !selectedFlowNode.value) return false
  const node = selectedFlowNode.value
  return node.kind === 'subAgent' && node.agentRole === 'worker'
})

const selectedRouteIndex = computed(() => {
  const node = selectedFlowNode.value
  if (!node || node.kind !== 'subAgent') return -1
  if (node.spawnIndex != null && node.spawnIndex < routeInstructions.value.length) {
    return node.spawnIndex
  }
  if (store.selectedFlowNodeId) {
    const parsed = parseRouteIndexFromNodeId(store.selectedFlowNodeId)
    if (parsed != null && parsed < routeInstructions.value.length) return parsed
  }
  if (node.agentName != null) {
    const idx = routeInstructions.value.findIndex(r => r.agentName === node.agentName)
    if (idx >= 0) return idx
  }
  return -1
})

const selectedClaimSource = computed(() => {
  const node = selectedFlowNode.value
  if (!node || !isSplitCommitStep.value) return null
  const state = graphState.value && isSplitState(graphState.value) ? graphState.value : null
  return resolveClaimFromNode(node, state, commitMergedClaims.value ?? mergedClaims.value)
})

const selectedMergedClaimIndex = computed(() => {
  const claim = selectedClaimSource.value
  if (!claim) return -1
  return findClaimIndex(claim, mergedClaims.value)
})

const showClaimCommitEdit = computed(
  () => isSplitCommitStep.value
    && selectedFlowNode.value?.kind === 'claim'
    && !selectedFlowNode.value.isBridge
    && selectedMergedClaimIndex.value >= 0,
)

const showClaimPendingDelete = computed(
  () => isSplitCommitStep.value
    && selectedFlowNode.value?.kind === 'claim'
    && !selectedFlowNode.value.isBridge
    && !!selectedClaimSource.value
    && selectedMergedClaimIndex.value < 0,
)

const showVerifyCommitEditor = computed(() => isVerifyCommitStep.value)

const showActions = computed(
  () => isInterrupted.value && nextNode.value != null,
)

const inlineEditorActive = computed(
  () => showCanvasAddRoute.value
    || showWorkerRouteEdit.value
    || showClaimCommitEdit.value
    || showClaimPendingDelete.value
    || showVerifyCommitEditor.value,
)

const isEditableStep = computed(
  () => inlineEditorActive.value,
)

const verifyState = computed(() =>
  graphState.value && !isSplitState(graphState.value) ? graphState.value : null,
)

const showPanelContent = computed(
  () => !!selectedFlowNode.value
    || isSplitCommitStep.value
    || isVerifyCommitStep.value
    || isRouteConfigPhase.value,
)

function formatJson(value: unknown) {
  if (value == null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function continueStep() {
  const patch = buildPatch()
  if (isSplitCommitStep.value || isVerifyCommitStep.value) {
    store.continueCommit(patch)
  } else {
    store.resume(patch)
  }
}

function removeSelectedRoute() {
  const index = selectedRouteIndex.value
  if (index < 0) return
  removeRoute(index)
  store.syncRouteInstructions(routeInstructions.value)
  store.selectFlowNode(null)
}

function removeSelectedClaim() {
  const index = selectedMergedClaimIndex.value
  if (index < 0) return
  removeClaim(index)
}

function restoreSelectedClaim() {
  const claim = selectedClaimSource.value
  if (!claim) return
  restoreClaim({ ...claim })
}

function onKeydown(event: KeyboardEvent) {
  if (!isEditableStep.value || !canUndo.value) return
  const key = event.key.toLowerCase()
  if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey) {
    event.preventDefault()
    undo()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <PanelRegion title="节点参数" class="inspector">
    <template #actions>
      <span v-if="isInterrupted" class="paused-tag">等待步进</span>
      <button
        v-if="selectedFlowNode"
        type="button"
        @click="store.selectFlowNode(null)"
      >
        清除
      </button>
    </template>

    <div v-if="!showPanelContent" class="empty">
      点击拓扑图中的节点查看或编辑参数
    </div>

    <div v-else class="content" :class="isEditableStep ? 'params-editable' : 'params-readonly'">
      <h3 v-if="showCanvasAddRoute" class="node-title">添加角度</h3>
      <h3 v-else-if="selectedFlowNode" class="node-title">{{ title }}</h3>
      <h3 v-else-if="isSplitCommitStep" class="node-title">确认合并并保存</h3>
      <h3 v-else-if="isVerifyCommitStep" class="node-title">确认核查并保存</h3>

      <p v-if="isSplitCommitStep && !selectedFlowNode" class="hint">
        点击图中的事实节点以编辑内容，或从保存列表中移除（图中将显示为虚线）。
      </p>

      <template v-if="showCanvasAddRoute">
        <section class="section edit-section">
          <p v-if="!canAddRoute" class="hint">暂无可用 SubAgent 类型。</p>
          <template v-else>
            <p class="hint">选择 SubAgent 类型并填写参数后点击「添加」。</p>
            <div class="edit-card">
              <label class="field">
                <span>SubAgent</span>
                <select v-model="newRouteDraft.agentName">
                  <option value="" disabled>请选择</option>
                  <option
                    v-for="agent in catalog"
                    :key="agent.name"
                    :value="agent.name"
                  >
                    {{ agent.name }}
                  </option>
                </select>
              </label>
              <label class="field">
                <span>优先级</span>
                <select v-model="newRouteDraft.priority">
                  <option v-for="p in priorities" :key="p" :value="p">{{ p }}</option>
                </select>
              </label>
              <label class="field">
                <span>Hint</span>
                <input v-model="newRouteDraft.hint" placeholder="可选" />
              </label>
              <button
                type="button"
                :disabled="!newRouteDraft.agentName.trim()"
                @click="submitAddRoute"
              >
                添加
              </button>
            </div>
          </template>
        </section>
      </template>

      <template v-else-if="showWorkerRouteEdit && selectedRouteIndex >= 0">
        <section class="section edit-section">
          <div class="edit-toolbar">
            <h4 class="section-title">SubAgent 参数</h4>
            <button type="button" class="undo-btn" :disabled="!canUndo" @click="undo">
              撤销 <kbd>⌘Z</kbd>
            </button>
          </div>
          <div class="edit-card">
            <label class="field">
              <span>SubAgent</span>
              <select
                :value="routeInstructions[selectedRouteIndex].agentName"
                @change="onWorkerAgentChange(($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="(agent, agentIdx) in editableRouteAgents"
                  :key="`${agentIdx}-${agent.name}`"
                  :value="agent.name"
                >
                  {{ agent.name }}
                </option>
              </select>
            </label>
            <label class="field">
              <span>优先级</span>
              <select v-model="routeInstructions[selectedRouteIndex].priority">
                <option v-for="p in priorities" :key="p" :value="p">{{ p }}</option>
              </select>
            </label>
            <label class="field">
              <span>Hint</span>
              <input
                v-model="routeInstructions[selectedRouteIndex].hint"
                placeholder="可选"
              />
            </label>
            <button type="button" class="danger-btn" @click="removeSelectedRoute">删除此角度</button>
          </div>
        </section>
      </template>

      <template v-else-if="showClaimCommitEdit">
        <section class="section edit-section">
          <div class="edit-toolbar">
            <h4 class="section-title">事实内容</h4>
            <button type="button" class="undo-btn" :disabled="!canUndo" @click="undo">
              撤销 <kbd>⌘Z</kbd>
            </button>
          </div>
          <div class="edit-card">
            <label class="field">
              <span>内容</span>
              <textarea
                v-model="mergedClaims[selectedMergedClaimIndex].content"
                rows="2"
              />
            </label>
            <label class="field">
              <span>分类</span>
              <input v-model="mergedClaims[selectedMergedClaimIndex].category" />
            </label>
            <button type="button" class="danger-btn" @click="removeSelectedClaim">
              从保存列表移除
            </button>
          </div>
        </section>
      </template>

      <template v-else-if="showClaimPendingDelete">
        <section class="section edit-section">
          <h4 class="section-title">待删除</h4>
          <div class="edit-card pending-card">
            <p class="pending-text">{{ selectedClaimSource?.content }}</p>
            <span v-if="selectedClaimSource?.category" class="tag">
              {{ selectedClaimSource.category }}
            </span>
            <button type="button" @click="restoreSelectedClaim">恢复至保存列表</button>
          </div>
        </section>
      </template>

      <template v-else-if="showVerifyCommitEditor">
        <p class="hint">合并核查意见与保存为同一步，确认后写入文档。</p>
        <section class="section edit-section">
          <div class="edit-toolbar">
            <h4 class="section-title">核查结论</h4>
            <button type="button" class="undo-btn" :disabled="!canUndo" @click="undo">
              撤销 <kbd>⌘Z</kbd>
            </button>
          </div>
          <div class="edit-card">
            <label class="field">
              <span>置信度</span>
              <select v-model.number="finalScore">
                <option v-for="s in scores" :key="s" :value="s">{{ s }}</option>
              </select>
            </label>
            <label class="field">
              <span>理由</span>
              <textarea v-model="finalReason" rows="3" />
            </label>
          </div>
        </section>
        <template v-if="verifyState">
          <section
            v-for="opinion in verifyState.subAgentOpinions"
            :key="opinion.agentName"
            class="section"
          >
            <h4 class="section-title">{{ opinion.agentName }}</h4>
            <p class="hint readonly-block">{{ opinion.score }} — {{ opinion.reason || '（无理由）' }}</p>
          </section>
        </template>
      </template>

      <section
        v-for="(section, i) in sections"
        v-show="!inlineEditorActive && !!selectedFlowNode"
        :key="i"
        class="section"
      >
        <h4 class="section-title">{{ section.title }}</h4>

        <table v-if="section.rows.length" class="param-table">
          <tbody>
            <tr v-for="row in section.rows" :key="row.key">
              <th>{{ row.key }}</th>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </table>

        <pre v-if="section.json !== undefined" class="json-block">{{ formatJson(section.json) }}</pre>
      </section>

      <div v-if="showActions" class="actions">
        <button v-if="isSplitCommitStep" type="button" @click="addClaim">+ 添加事实</button>
        <button type="button" class="primary" @click="continueStep">继续</button>
      </div>
    </div>
  </PanelRegion>
</template>

<style scoped>
.inspector {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.paused-tag {
  font-size: var(--ui-font-size);
  color: var(--warning);
  margin-right: var(--space-xs);
}

.empty {
  padding: var(--space-md);
  color: var(--text-dim);
  font-size: var(--ui-font-size-md);
  line-height: 1.5;
}

.content {
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.node-title {
  font-size: var(--ui-font-size-lg);
  font-weight: 600;
}

.section-title {
  font-size: var(--ui-font-size);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0;
}

.edit-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-bottom: var(--space-xs);
}

.undo-btn {
  font-size: var(--ui-font-size);
  padding: 1px 6px;
  color: var(--text-muted);
}

.undo-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.undo-btn kbd {
  font-size: 10px;
  font-family: var(--ui-font);
  opacity: 0.7;
}

.hint {
  font-size: var(--ui-font-size-md);
  color: var(--text-muted);
  line-height: 1.45;
}

.edit-card {
  border: 1px solid var(--border-subtle);
  padding: var(--space-sm);
  margin-bottom: var(--space-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  background: var(--param-editable-bg);
}

.pending-card {
  background: var(--param-readonly-bg);
  border-style: dashed;
  opacity: 0.85;
}

.pending-text {
  font-size: var(--ui-font-size-md);
  color: var(--text-muted);
  text-decoration: line-through;
}

.tag {
  align-self: flex-start;
  font-size: var(--ui-font-size);
  background: var(--bg-header);
  padding: 0 4px;
  border-radius: var(--radius);
}

.params-editable .edit-card input,
.params-editable .edit-card select,
.params-editable .edit-card textarea {
  background: var(--param-editable-bg);
  border-color: var(--border);
}

.params-readonly .param-table td {
  background: var(--param-readonly-bg);
  color: var(--text);
}

.params-readonly .json-block,
.params-readonly .readonly-block {
  background: var(--param-readonly-bg);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
}

.params-readonly .readonly-block {
  padding: var(--space-sm);
  margin: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.field span {
  font-size: var(--ui-font-size);
  color: var(--text-muted);
}

.danger-btn {
  align-self: flex-start;
  color: var(--danger);
  border-color: var(--danger);
}

.param-table th {
  width: 36%;
  font-weight: 500;
  color: var(--text-muted);
  vertical-align: top;
}

.param-table td {
  word-break: break-word;
}

.json-block {
  margin: 0;
  padding: var(--space-sm);
  font-size: var(--ui-font-size);
  line-height: 1.45;
  font-family: ui-monospace, monospace;
  border: 1px solid var(--border-subtle);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border);
  margin-top: auto;
}
</style>
