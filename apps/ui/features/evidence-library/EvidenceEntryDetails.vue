<!-- 证据库条目详情：固定判断、范围、出处、依据与当前状态。 -->
<script setup lang="ts">
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import { computed, ref, watch } from 'vue'

import type { ClientErrorData, ClientGateway } from '../../../../contracts/client'
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { EvidenceClaimRef, EvidenceLibraryEntry, EvidenceRelationNode, EvidenceRelationsView } from '../../../../contracts/evidence-library'
import DataPayloadView from '../reader/DataPayloadView.vue'
import EvidenceUsesPanel from './EvidenceUsesPanel.vue'
import EvidenceRelationDetails from './EvidenceRelationDetails.vue'
import type { EvidenceUsesContext } from './evidence-uses'
import { evidenceReadBasis, evidenceReadJudgment, evidenceReadRelationPresentation, evidenceReadRelationRole, evidenceReadScope, evidenceReadStatus, type EvidenceBasisOpen, type EvidenceBasisPresentation } from './evidence-presentation'

const props = withDefaults(defineProps<{
  entry: EvidenceLibraryEntry | null
  loading: boolean
  error: ClientErrorData | null
  canEdit: boolean
  busy: boolean
  showPageLink?: boolean
  relationNode?: EvidenceRelationNode | null
  relations?: EvidenceRelationsView | null
  showRelations?: boolean
  catalog?: DefinitionCatalog | null
  showContent?: boolean
  gateway?: ClientGateway | null
  usesContext?: EvidenceUsesContext | null
}>(), { showPageLink: true, relationNode: null, relations: null, showRelations: true, catalog: null, showContent: true, gateway: null, usesContext: null })
const emit = defineEmits<{
  openPage: []
  openSource: [ref: EvidenceClaimRef]
  openBasis: [input: EvidenceBasisOpen]
  withdraw: [reason: string]
  unauthorized: []
  openConsumer: [ref: EvidenceClaimRef]
  selectionChanged: []
}>()
const scope = computed(() => /* 只投影当前固定条目的范围，空选择没有范围。 */ props.entry ? evidenceReadScope(props.entry.applicability) : [])
const basis = computed(() => /* 只展示当前条目真实保存的依据。 */ props.entry ? evidenceReadBasis(props.entry.decision.basisRefs) : [])
const relationPresentation = computed(() => /* 邻域正文只读取关系包已保存快照。 */ props.relationNode ? evidenceReadRelationPresentation(props.relationNode, props.catalog) : null)
const withdrawing = ref(false)
const reason = ref('')
const usesContext = computed<EvidenceUsesContext | null>(() => {
  // 使用记录只能属于真实库根；邻域以及不可见模式不启动查询。
  const context = props.usesContext
  if (!context) return null
  return { ...context, entryId: props.entry?.id ?? null,
    active: context.active && props.relationNode === null && props.entry !== null && props.entry.workspaceId === context.workspaceId }
})

function detailsOpenBasis(
  /* 当前根条目已经冻结的一行依据，保留原顺序索引与完整typed引用。 */ item: EvidenceBasisPresentation,
): void {
  // 以原库根身份和摘要绑定打开意图，实际读取与导航由父页面按依据类型处理。
  const entry = props.entry
  if (!entry || props.relationNode || props.busy) return
  emit('openBasis', { entryId: entry.id, contentDigest: entry.contentDigest, basisIndex: item.basisIndex, basis: item.basis })
}

function submitWithdrawal(): void {
  // 使用明确理由发出撤回意图，revision 与稳定命令身份由状态模块维护。
  if (props.relationNode || !props.entry || props.entry.status !== 'active' || !props.canEdit || props.busy || !reason.value.trim()) return
  emit('withdraw', reason.value.trim())
}

watch(() => /* 切换根、邻域或接纳新状态后不保留其他选择的撤回草稿。 */ `${props.entry?.id}:${props.entry?.revision}:${props.relationNode?.key}`, () => {
  // 每个撤回理由只属于打开时的条目版本。
  withdrawing.value = false
  reason.value = ''
})
</script>

<template>
  <aside class="evidence-details" aria-label="证据条目详情" :aria-busy="loading || busy">
    <header><h2>{{ relationNode ? '固定关联材料' : '证据条目' }}</h2><span v-if="relationNode" class="status">{{ evidenceReadRelationRole(relationNode.role) }}</span><span v-else-if="entry" class="status">{{ evidenceReadStatus(entry.status) }}</span></header>
    <template v-if="relationNode && relationPresentation">
      <p class="fixed-note">此材料保存在当前证据条目的关系快照中。</p>
      <button v-if="showPageLink" type="button" class="text-action" @click="emit('openPage')">打开固定单页 ↗</button>
      <section><h3>{{ relationPresentation.heading }}</h3><DataPayloadView v-if="showContent" :fields="relationPresentation.fields" /><dl class="scope"><div><dt>关系角色</dt><dd>{{ evidenceReadRelationRole(relationNode.role) }}</dd></div><div><dt>原数据图</dt><dd>{{ relationNode.ref.mapId }}</dd></div><div><dt>节点</dt><dd>{{ relationNode.ref.nodeId }}</dd></div><div><dt>原版本</dt><dd>{{ relationNode.ref.revision }}</dd></div><div><dt>数据类型</dt><dd>{{ relationNode.nodeSnapshot.typeId }} · 第 {{ relationNode.nodeSnapshot.typeVersion }} 版</dd></div><div><dt>定义摘要</dt><dd class="digest">{{ relationNode.definitionDigest }}</dd></div></dl></section>
      <section><h3>出处</h3><button type="button" class="text-action" @click="emit('openSource', relationNode.ref)">定位来源（原版本 {{ relationNode.ref.revision }}）↗</button><p class="fixed-note">来源数据图显示当前内容；固定单页保留此材料的原版本。</p></section>
    </template>
    <p v-else-if="loading" class="details-state" role="status">正在读取固定快照…</p>
    <template v-else-if="entry">
      <div class="judgment" :class="{ false: entry.confidence === 0, inactive: entry.status !== 'active' }">{{ evidenceReadJudgment(entry.confidence) }}</div>
      <p class="fixed-note">此判断、原文、适用范围和依据在收录时固定。</p>
      <button v-if="showPageLink" type="button" class="text-action" @click="emit('openPage')">打开固定单页 ↗</button>

      <section><h3>适用范围</h3><dl class="scope"><div v-for="row in scope" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div></dl></section>
      <section><h3>收录理由</h3><p class="body-text">{{ entry.decision.reason }}</p></section>
      <section aria-label="收录依据">
        <h3>收录依据</h3>
        <p v-if="!basis.length" class="muted">未添加依据引用。</p>
        <article v-for="item in basis" :key="item.key" class="basis">
          <small>{{ item.label }}</small>
          <p>{{ item.text }}</p>
          <div v-if="item.basis.kind !== 'manual'" class="basis-actions">
            <button v-if="item.basis.kind === 'node'" type="button" class="text-action"
              :aria-label="`阅读固定节点依据 ${item.basisIndex + 1}`" :disabled="busy" @click="detailsOpenBasis(item)">阅读固定节点依据 ↗</button>
            <button v-if="item.claim" type="button" class="text-action"
              :aria-label="`定位当前节点依据 ${item.basisIndex + 1}`" :disabled="busy" @click="emit('openSource', item.claim)">定位当前节点 ↗</button>
            <button v-if="item.basis.kind === 'asset'" type="button" class="text-action"
              :aria-label="`下载依据文件 ${item.basisIndex + 1}`" :disabled="busy" @click="detailsOpenBasis(item)">下载依据文件</button>
            <button v-if="item.basis.kind === 'library'" type="button" class="text-action"
              :aria-label="`查看固定库依据 ${item.basisIndex + 1}`" :disabled="busy" @click="detailsOpenBasis(item)">查看固定库依据 ↗</button>
          </div>
          <p v-if="item.basis.kind === 'node'" class="fixed-note">定位当前节点会打开当前数据图；历史正文请阅读固定节点依据。</p>
        </article>
      </section>
      <section><h3>原事实出处</h3><dl class="scope"><div><dt>数据图</dt><dd>{{ entry.claim.origin.mapId }}</dd></div><div><dt>节点</dt><dd>{{ entry.claim.origin.nodeId }}</dd></div><div><dt>原版本</dt><dd>{{ entry.claim.origin.revision }}</dd></div><div><dt>数据类型</dt><dd>{{ entry.claim.type.id }} · 第 {{ entry.claim.type.version }} 版</dd></div></dl><button type="button" class="text-action" @click="emit('openSource', entry.claim.origin)">定位来源（原版本 {{ entry.claim.origin.revision }}）↗</button><p class="fixed-note">来源数据图显示当前内容；本页保存收录时的原版本。</p></section>
      <section><h3>收录记录</h3><dl class="scope"><div><dt>收录人</dt><dd>{{ entry.collectedBy }}</dd></div><div><dt>收录时间</dt><dd>{{ entry.collectedAt }}</dd></div><div><dt>条目版本</dt><dd>{{ entry.revision }}</dd></div><div><dt>内容摘要</dt><dd class="digest">{{ entry.contentDigest }}</dd></div></dl><p v-if="entry.statusReason" class="body-text">{{ evidenceReadStatus(entry.status) }}理由：{{ entry.statusReason }}</p><p v-if="entry.replacementEntryId" class="muted">替代条目：{{ entry.replacementEntryId }}</p></section>
      <EvidenceUsesPanel v-if="gateway && usesContext" :gateway="gateway" :context="usesContext" :catalog="catalog" @unauthorized="emit('unauthorized')" @open-consumer="emit('openConsumer', $event)" @selection-changed="emit('selectionChanged')" />

      <section v-if="canEdit && entry.status === 'active'" class="withdraw-section"><button v-if="!withdrawing" type="button" :disabled="busy" @click="withdrawing = true">撤回条目</button><form v-else @submit.prevent="submitWithdrawal"><label>撤回理由<textarea v-model="reason" required rows="3" :disabled="busy" /></label><p class="fixed-note">撤回后保留固定内容和记录。</p><div class="withdraw-actions"><button type="button" :disabled="busy" @click="withdrawing = false">取消</button><button type="submit" :disabled="busy || !reason.trim()">{{ busy ? '提交中…' : '确认撤回' }}</button></div></form></section>
    </template>
    <p v-else class="details-state">在库中选择条目，查看固定判断与依据。</p>
    <EvidenceRelationDetails v-if="showRelations && relations && (entry || relationNode) && !loading" :view="relations"
      :node-key="relationNode?.key ?? relations.snapshot?.rootKey ?? null" :catalog="catalog" />
    <p v-if="error" class="error" role="alert" :title="`${error.code}: ${error.message}`">{{ uiReadErrorMessage(error.message) }}</p>
  </aside>
</template>

<style scoped>
.basis-actions { display:flex; flex-wrap:wrap; gap:6px 12px; }
.evidence-details{min-width:0;height:100%;overflow:auto;padding:18px;background:var(--bg-panel);color:var(--text)}header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}h2{font-size:14px;font-weight:650}.status{font-size:11px;color:var(--text-muted)}.judgment{width:fit-content;padding:7px 10px;border:1px solid color-mix(in srgb,var(--success) 30%,var(--border));border-radius:var(--radius-evidence);background:color-mix(in srgb,var(--success) 5%,var(--bg-panel));color:var(--success);font-size:13px;font-weight:650}.judgment.false{border-color:color-mix(in srgb,var(--danger) 30%,var(--border));background:color-mix(in srgb,var(--danger) 5%,var(--bg-panel));color:var(--danger)}.judgment.inactive{color:var(--text-muted);border-color:var(--border);background:var(--bg-related)}.fixed-note,.muted,.details-state{color:var(--text-muted);font-size:11px;line-height:1.8;overflow-wrap:anywhere}.fixed-note{margin:8px 0}.details-state{padding:14px 0}.text-action{padding:4px 0;border:0;background:transparent;color:var(--accent);font-size:11px;text-align:left}.text-action:hover{text-decoration:underline}section{display:grid;gap:9px;padding:16px 0;border-bottom:1px solid var(--border)}h3{font-size:12px;font-weight:650}.scope{display:grid;gap:7px}.scope>div{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px;font-size:11px;line-height:1.8}.scope dt{color:var(--text-muted)}.scope dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.digest{font-family:var(--ui-font);font-size:10px}.body-text{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.9 var(--content-font)}.basis{display:grid;gap:6px;padding:9px 11px;border-left:2px solid var(--border-evidence);background:var(--bg-related)}.basis small{color:var(--text-muted);font-size:10px}.basis p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.8}.withdraw-section{border-bottom:0}.withdraw-section>button{justify-self:start}.withdraw-section form{display:grid;gap:8px}.withdraw-section label{display:grid;gap:7px;font-size:11px}.withdraw-section textarea{width:100%;padding:7px;resize:vertical}.withdraw-actions{display:flex;gap:7px;justify-content:flex-end}.withdraw-actions button{padding:6px 8px;font-size:11px}.error{margin-top:12px;color:var(--danger);font-size:12px;line-height:1.8;overflow-wrap:anywhere}
</style>
