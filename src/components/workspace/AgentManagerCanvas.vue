<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Priority } from '../../flow-map'
import type {
  AgentRegistryDetail,
  AgentRegistryItem,
  AgentType,
  AppSettingsDto,
  ClaimCategory,
  PromptKind,
  PromptVarDescriptor,
  SkillDescriptor,
} from '../../../electron/api/types'
import PanelRegion from '../shell/PanelRegion.vue'
import SkillMultiSelect from './SkillMultiSelect.vue'
import PromptVarMultiSelect from './PromptVarMultiSelect.vue'
import PromptOutputPreview from './PromptOutputPreview.vue'
import AgentSettingsPanel from './AgentSettingsPanel.vue'
import { agentManagerPendingCreate } from '../../stores/agent-manager-ui'
import { chromeShowToast } from '../../chrome/use-chrome-menu'

const TYPE_LABELS: Record<AgentType, string> = {
  split: 'Split',
  verify: 'Verify',
  parse: 'Parse',
  coordinator: '协调者',
}

const CREATE_TYPES: Array<'split' | 'verify'> = ['split', 'verify']

interface AgentForm {
  agentName: string
  displayLabel: string
  content: string
  promptVars: string[]
  claimCategory: ClaimCategory
  defaultPriority: Priority
  description: string
  tools: string[]
  model: string
  baseUrl: string
  agentType: AgentType
  endpointSlug: string
}

const agents = ref<AgentRegistryItem[]>([])
const selectedPath = ref<string | null>(null)
const creating = ref(false)
const busy = ref(false)
const settingsOpen = ref(false)
const skillCatalog = ref<SkillDescriptor[]>([])
const promptVarSlots = ref<PromptVarDescriptor[]>([])
const appSettings = ref<AppSettingsDto | null>(null)

const form = ref<AgentForm>({
  agentName: '',
  displayLabel: '',
  content: '',
  promptVars: [],
  claimCategory: 'data',
  defaultPriority: 'medium',
  description: '',
  tools: [],
  model: '',
  baseUrl: '',
  agentType: 'split',
  endpointSlug: '',
})

const selectedItem = computed(() =>
  agents.value.find(a => a.id === selectedPath.value) ?? null,
)

const promptKind = computed<PromptKind>(() => {
  if (creating.value) {
    return form.value.agentType === 'verify' ? 'verifySubAgent' : 'splitSubAgent'
  }
  return selectedItem.value?.kind ?? 'splitSubAgent'
})

const isSubAgent = computed(() =>
  form.value.agentType === 'split' || form.value.agentType === 'verify',
)

const endpointDisplay = computed(() => {
  if (!creating.value && selectedPath.value) return selectedPath.value
  if (form.value.agentType === 'split') {
    return `fact-extractor/sub-agents/${form.value.endpointSlug || '{slug}'}`
  }
  if (form.value.agentType === 'verify') {
    return `fact-verifier/sub-agents/${form.value.endpointSlug || '{slug}'}`
  }
  return ''
})

const globalModelPlaceholder = computed(
  () => appSettings.value?.defaults.model ?? 'deepseek-v4-flash',
)

const globalBaseUrlPlaceholder = computed(
  () => appSettings.value?.defaults.baseUrl ?? 'https://api.deepseek.com',
)

function typeLabel(type: AgentType): string {
  return TYPE_LABELS[type]
}

async function loadPromptVarSlots(kind: PromptKind) {
  promptVarSlots.value = await window.electronAPI?.promptVars.list(kind) ?? []
}

function formResetBlank() {
  form.value = {
    agentName: '',
    displayLabel: '',
    content: '',
    promptVars: promptVarSlots.value.map(s => s.id),
    claimCategory: 'data',
    defaultPriority: 'medium',
    description: '',
    tools: [],
    model: '',
    baseUrl: '',
    agentType: 'split',
    endpointSlug: '',
  }
}

async function loadSkills() {
  skillCatalog.value = await window.electronAPI?.skills.list() ?? []
}

async function loadAppSettings() {
  appSettings.value = await window.electronAPI?.app.getSettings() ?? null
}

async function loadList() {
  agents.value = await window.electronAPI?.agentRegistry.list() ?? []
}

function applyDetail(detail: AgentRegistryDetail) {
  form.value = {
    agentName: detail.agentName ?? '',
    displayLabel: detail.displayLabel,
    content: detail.content,
    promptVars: [...detail.promptVars],
    claimCategory: detail.claimCategory ?? 'data',
    defaultPriority: detail.defaultPriority ?? 'medium',
    description: detail.description ?? '',
    tools: detail.tools ?? [],
    model: detail.model ?? '',
    baseUrl: detail.baseUrl ?? '',
    agentType: detail.agentType,
    endpointSlug: '',
  }
}

async function loadDetail(promptPath: string) {
  const detail = await window.electronAPI?.agentRegistry.get(promptPath)
  if (!detail) return
  await loadPromptVarSlots(detail.kind)
  applyDetail(detail)
}

function onSelect(agent: AgentRegistryItem) {
  creating.value = false
  selectedPath.value = agent.id
  void loadDetail(agent.id)
}

async function onNew() {
  creating.value = true
  selectedPath.value = null
  await loadPromptVarSlots('splitSubAgent')
  formResetBlank()
}

async function onSave() {
  const api = window.electronAPI?.agentRegistry
  if (!api || busy.value) return

  const label = form.value.displayLabel.trim()
  if (!label) {
    chromeShowToast('请填写显示名称')
    return
  }

  busy.value = true
  try {
    if (creating.value) {
      const name = form.value.agentName.trim()
      const slug = form.value.endpointSlug.trim()
      if (!name || !slug) {
        chromeShowToast('请填写 agentName 与 endpoint slug')
        return
      }
      const created = await api.create({
        agentType: form.value.agentType as 'split' | 'verify',
        agentName: name,
        displayLabel: label,
        content: form.value.content,
        endpointSlug: slug,
        promptVars: form.value.promptVars,
        claimCategory: form.value.agentType === 'split'
          ? form.value.claimCategory
          : undefined,
        defaultPriority: form.value.defaultPriority,
        description: form.value.description.trim() || undefined,
        tools: form.value.tools.length > 0 ? form.value.tools : undefined,
        model: form.value.model.trim() || undefined,
        baseUrl: form.value.baseUrl.trim() || undefined,
      })
      chromeShowToast('已创建智能体')
      creating.value = false
      selectedPath.value = created.promptPath
    } else if (selectedPath.value) {
      const patch = {
        displayLabel: label,
        content: form.value.content,
        promptVars: form.value.promptVars,
        description: form.value.description.trim() || undefined,
      } as Parameters<typeof api.update>[1]

      if (isSubAgent.value) {
        patch.agentName = form.value.agentName.trim()
        patch.defaultPriority = form.value.defaultPriority
        patch.tools = form.value.tools
        if (form.value.agentType === 'split') {
          patch.claimCategory = form.value.claimCategory
        }
      }

      patch.model = form.value.model.trim()
      patch.baseUrl = form.value.baseUrl.trim()

      await api.update(selectedPath.value, patch)
      chromeShowToast('已保存')
    }
    await loadList()
    if (selectedPath.value) await loadDetail(selectedPath.value)
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '保存失败')
  } finally {
    busy.value = false
  }
}

async function onDelete() {
  const api = window.electronAPI?.agentRegistry
  if (!api || !selectedPath.value || busy.value || !selectedItem.value?.deletable) return
  const name = selectedItem.value.displayLabel
  if (!confirm(`删除智能体「${name}」？`)) return
  busy.value = true
  try {
    await api.delete(selectedPath.value)
    chromeShowToast('已删除')
    selectedPath.value = null
    creating.value = false
    formResetBlank()
    await loadList()
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '删除失败')
  } finally {
    busy.value = false
  }
}

async function onReload() {
  const api = window.electronAPI?.agentRegistry
  if (!api || busy.value) return
  busy.value = true
  try {
    await api.reload()
    await loadList()
    if (selectedPath.value) await loadDetail(selectedPath.value)
    chromeShowToast('目录已重载')
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '重载失败')
  } finally {
    busy.value = false
  }
}

watch(
  () => form.value.agentType,
  async (type) => {
    if (!creating.value) return
    const kind = type === 'verify' ? 'verifySubAgent' : 'splitSubAgent'
    await loadPromptVarSlots(kind)
    form.value.promptVars = promptVarSlots.value.map(s => s.id)
    if (type === 'split') form.value.claimCategory = 'data'
  },
)

watch(agentManagerPendingCreate, (pending) => {
  if (!pending) return
  agentManagerPendingCreate.value = false
  void onNew()
})

onMounted(() => {
  void loadSkills()
  void loadAppSettings()
  void loadList()
  if (agentManagerPendingCreate.value) {
    agentManagerPendingCreate.value = false
    void onNew()
  }
})
</script>

<template>
  <div class="agent-canvas">
    <PanelRegion title="智能体管理" class="agent-panel">
      <div class="toolbar">
        <div class="toolbar-actions">
          <button type="button" :disabled="busy" @click="settingsOpen = true">设置</button>
          <button type="button" :disabled="busy" @click="onNew">新建</button>
          <button type="button" :disabled="busy" @click="onReload">重载目录</button>
        </div>
      </div>

      <div class="body">
        <aside class="agent-list-col">
          <ul class="agent-list">
            <li
              v-for="agent in agents"
              :key="agent.id"
              :class="{ selected: selectedPath === agent.id && !creating }"
              @click="onSelect(agent)"
            >
              <div class="row-top">
                <span class="name">{{ agent.displayLabel }}</span>
                <span class="type-badge">{{ typeLabel(agent.agentType) }}</span>
              </div>
              <div class="meta">{{ agent.agentName ?? agent.promptPath }}</div>
            </li>
            <li v-if="agents.length === 0" class="empty">暂无智能体</li>
          </ul>
        </aside>

        <div class="editor-pane panel">
          <div v-if="creating || selectedPath" class="editor">
            <h3>{{ creating ? '新建智能体' : '编辑智能体' }}</h3>

            <label class="field">
              <span>智能体类型</span>
              <select v-model="form.agentType" :disabled="!creating">
                <template v-if="creating">
                  <option v-for="t in CREATE_TYPES" :key="t" :value="t">
                    {{ typeLabel(t) }}
                  </option>
                </template>
                <template v-else>
                  <option :value="form.agentType">{{ typeLabel(form.agentType) }}</option>
                </template>
              </select>
            </label>

            <label class="field">
              <span>endpoint</span>
              <input
                v-if="creating"
                v-model="form.endpointSlug"
                type="text"
                placeholder="文件 slug，如 data-claims"
                spellcheck="false"
              >
              <input
                v-else
                :value="endpointDisplay"
                type="text"
                readonly
                spellcheck="false"
              >
              <span v-if="creating" class="hint">{{ endpointDisplay }}</span>
            </label>

            <label v-if="isSubAgent" class="field">
              <span>agentName</span>
              <input
                v-model="form.agentName"
                type="text"
                :disabled="!creating"
                spellcheck="false"
              >
            </label>

            <label class="field">
              <span>显示名称</span>
              <input v-model="form.displayLabel" type="text">
            </label>

            <label v-if="form.agentType === 'split'" class="field">
              <span>数据类型（claimCategory）</span>
              <select v-model="form.claimCategory">
                <option value="data">data — 数值/统计/日期</option>
                <option value="quote">quote — 引语/表态</option>
                <option value="causal">causal — 因果/推断</option>
              </select>
            </label>

            <template v-if="isSubAgent">
              <label class="field">
                <span>defaultPriority</span>
                <select v-model="form.defaultPriority">
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </label>
              <label class="field">
                <span>description</span>
                <input v-model="form.description" type="text">
              </label>
              <SkillMultiSelect
                v-model="form.tools"
                :skills="skillCatalog"
                :tavily-configured="appSettings?.configured.tavilyApiKey"
              />
            </template>

            <label class="field">
              <span>model（可选，留空使用全局）</span>
              <input
                v-model="form.model"
                type="text"
                :placeholder="globalModelPlaceholder"
                spellcheck="false"
              >
            </label>
            <label class="field">
              <span>baseUrl（可选，留空使用全局）</span>
              <input
                v-model="form.baseUrl"
                type="text"
                :placeholder="globalBaseUrlPlaceholder"
                spellcheck="false"
              >
            </label>

            <PromptVarMultiSelect
              v-model="form.promptVars"
              :slots="promptVarSlots"
            />
            <label class="field">
              <span>指令正文</span>
              <textarea v-model="form.content" rows="10" spellcheck="false" />
            </label>
            <PromptOutputPreview
              :kind="promptKind"
              :claim-category="form.agentType === 'split' ? form.claimCategory : undefined"
            />
            <div class="actions">
              <button
                v-if="!creating && selectedItem?.deletable"
                type="button"
                class="danger"
                :disabled="busy"
                @click="onDelete"
              >
                删除
              </button>
              <button type="button" class="primary" :disabled="busy" @click="onSave">
                {{ busy ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
          <p v-else class="placeholder">选择左侧智能体或点击「新建」</p>
        </div>
      </div>
    </PanelRegion>

    <AgentSettingsPanel
      v-model:visible="settingsOpen"
      @saved="loadAppSettings"
    />
  </div>
</template>

<style scoped>
.agent-canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.agent-canvas :deep(.panel-region) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.agent-canvas :deep(.panel-region-body) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.toolbar {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-bottom: var(--space-md);
  gap: var(--space-sm);
}

.toolbar-actions {
  display: flex;
  gap: var(--space-sm);
}

.body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: var(--space-md);
  align-items: stretch;
}

.agent-list-col {
  width: 240px;
  min-width: 240px;
  max-width: 240px;
  min-height: 0;
  height: 100%;
}

.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  height: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: auto;
  box-sizing: border-box;
}

.agent-list li {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-subtle);
  border-left: 3px solid transparent;
  box-sizing: border-box;
  cursor: pointer;
}

.agent-list li.selected {
  background: var(--bg-viewport);
  border-left-color: var(--accent, #2563eb);
  padding-left: 7px;
}

.agent-list li.empty {
  color: var(--text-muted);
  cursor: default;
  font-size: var(--ui-font-size-sm);
}

.row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.name {
  font-weight: 500;
  font-size: var(--ui-font-size-sm);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  background: var(--bg-viewport);
}

.meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-pane {
  min-width: 0;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor {
  padding: var(--space-md);
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.editor h3 {
  margin: 0 0 var(--space-sm);
  font-size: var(--ui-font-size-md);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-sm);
  font-size: var(--ui-font-size-sm);
}

.field input,
.field select,
.field textarea {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-viewport);
  color: var(--text);
  font-family: inherit;
}

.field input[readonly] {
  color: var(--text-muted);
  background: var(--bg-panel);
}

.field textarea {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  resize: vertical;
}

.hint {
  font-size: 11px;
  color: var(--text-muted);
  font-family: ui-monospace, monospace;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: var(--space-md);
  color: var(--text-muted);
  font-size: var(--ui-font-size-sm);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}

button.primary {
  background: var(--accent, #2563eb);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
}

button.danger {
  margin-right: auto;
  color: var(--danger);
  border: 1px solid var(--danger);
  background: transparent;
  padding: 6px 12px;
  border-radius: 4px;
}
</style>
