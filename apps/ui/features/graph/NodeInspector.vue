<!-- 通用数据详情：用精确类型定义编辑 payload，并从可用转换启动有限运行计划。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { EvidenceLibraryRef } from '../../../../contracts/evidence-library'
import type { DefinitionCatalog, DefinitionRef } from '../../../../contracts/data-definition'
import type { GraphBranchGrant, GraphBranchProof, GraphBranchSnapshot } from '../../../../contracts/graph-branch'
import type { GraphEdge, GraphNode, GraphPayload } from '../../../../contracts/graph'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import DataPayloadEditor from './DataPayloadEditor.vue'
import { graphReadAvailableTransitions, graphReadNodeText, graphReadNodeType } from './graph-layout'
import { definitionKey, payloadFindType } from './data-payload'
import { nodeReadOrigin, type OperationOriginOpen } from './node-origin'
import NodeProvenance from './NodeProvenance.vue'

const props = defineProps<{ snapshot: GraphSnapshot; branch: GraphBranchSnapshot | null; grant: GraphBranchGrant | null; branchLoading: boolean; catalog: DefinitionCatalog | null; selectedId: string | null; canEdit: boolean; busy: boolean; leasesRequired: boolean; libraryAvailable?: boolean; historyAvailable?: boolean }>()
const emit = defineEmits<{
  save: [input: { branch: GraphBranchProof; nodeId: string; typeId: string; typeVersion: number; payload: GraphPayload }]
  remove: [input: { branch: GraphBranchProof; nodeId: string }]
  run: [input: { workspaceId: string; mapId: string; nodeId: string; transitionRef: DefinitionRef }]
  claim: []
  release: []
  child: [input: { parentId: string; childType: { id: string; version: number } }]
  editEvidence: [input: { mapId: string; nodeId: string; expectedNodeRevision: number }]
  openEvidence: [input: { workspaceId: string; ref: EvidenceLibraryRef }]
  openOperation: [input: OperationOriginOpen]
}>()

const selected = computed(() => props.snapshot.nodes.find(node => node.id === props.selectedId) ?? null)
const definition = computed(() => selected.value ? payloadFindType(props.catalog, selected.value) : undefined)
function inspectorReadScope(rootIds: string[]): Set<string> {
  const successors = new Map<string, string[]>()
  for (const edge of props.snapshot.edges) if (edge.kind === 'successor') successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to])
  const result = new Set<string>(), pending = [...rootIds]
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]
    if (result.has(id)) continue
    result.add(id); pending.push(...(successors.get(id) ?? []))
  }
  return result
}
const activeRun = computed(() => {
  if (!props.branch) return false
  return props.snapshot.runs.some(run => {
    if (!['running', 'waiting'].includes(run.status)) return false
    const running = inspectorReadScope(run.scope.nodeIds)
    return props.branch!.scope.nodeIds.some(id => running.has(id))
  })
})
const owned = computed(() => !props.leasesRequired || !!props.grant && !!props.branch && props.grant.rootIds.length === props.branch.scope.rootIds.length
  && props.grant.rootIds.every(id => props.branch!.scope.rootIds.includes(id)))
const branchOwner = computed(() => {
  // 按当前分支实际范围查找仍有效的公开占用。
  const branch = props.branch
  return branch && props.snapshot.ownerships.find((/* 服务端快照中的一份公开占用。 */ ownership) =>
    /* Run 占用或尚未到期的编辑占用会影响相交分支。 */
    (ownership.kind === 'run' || Date.parse(ownership.expiresAt) > Date.now())
    && ownership.scope.nodeIds.some((/* 占用范围内的节点身份。 */ id) =>
      /* 只显示与当前分支重叠的占用。 */ branch.scope.nodeIds.includes(id)))
})
const proofReady = computed(() => {
  // 只在会话已完成内容/证明配对且当前根版本相符时建立可编辑基线，全图 revision 不作永久门禁。
  const node = selected.value, branch = props.branch
  return !props.branchLoading && !!node && !!branch && branch.scope.rootIds.length === 1
    && branch.scope.rootIds[0] === node.id && branch.rootRevisions[node.id] === node.revision
})
const draft = ref<GraphPayload | null>(null)
const basePayload = ref('')
const baseVersion = ref<string | null>(null)
const pendingPayload = ref<string | null>(null)
const editable = computed(() => /* 未就绪的证明或未知草稿基线不能接受新的表单输入。 */
  props.canEdit && !props.busy && !activeRun.value && owned.value && !!definition.value && proofReady.value && baseVersion.value !== null)
const canSave = computed(() => /* 释放部分授权后仍可提交保留的草稿，由会话取得完整写入范围。 */
  props.canEdit && !props.busy && !activeRun.value && !!definition.value && proofReady.value && baseVersion.value !== null)
const successorTypes = computed(() => /* 入口只来自精确父类型已发布的合法后继。 */
  (props.catalog?.dataTypes ?? []).filter((/* 目录中的精确类型定义。 */ type) => /* 未解析的类型不成为创建入口。 */ definition.value?.successorTypes.some((/* 父定义允许的一项类型。 */ allowed) => /* ID和版本同时匹配。 */ allowed.id === type.id && allowed.version === type.version)))
const transitionKey = ref('')
const serialized = computed(() => JSON.stringify(draft.value))
const dirty = computed(() => draft.value !== null && serialized.value !== basePayload.value)
const versionChanged = computed(() => /* 缺少证明只是未就绪，只有已知的新内容版本才显示真实冲突。 */
  dirty.value && proofReady.value && !!props.branch && baseVersion.value !== null && baseVersion.value !== props.branch.version)
const transitions = computed(() => selected.value ? graphReadAvailableTransitions([selected.value], props.catalog) : [])
const transition = computed(() => transitions.value.find(item => definitionKey(item) === transitionKey.value) ?? transitions.value[0])
const outgoing = computed(() => /* 当前节点指向的显式关系与其真实终点。 */ inspectorReadRelations('outgoing'))
const incoming = computed(() => /* 当前节点收到的显式关系与其真实起点。 */ inspectorReadRelations('incoming'))

function inspectorReadRelations(
  /* 从当前节点看入边或出边，不包含正文派生的引用索引。 */ direction: 'incoming' | 'outgoing',
): Array<{ edge: GraphEdge; node: GraphNode }> {
  // 只建立两端真实存在的关系列表，展示和按钮共用同一对象，无须非空断言。
  const current = selected.value
  if (!current) return []
  return props.snapshot.edges.flatMap((/* 当前图的一条显式关系。 */ edge) => {
    // 按阅读方向取得另一端，已删除或缺失的端点不成为可编辑列表项。
    const matches = direction === 'incoming' ? edge.to === current.id : edge.from === current.id
    if (!matches) return []
    const otherId = direction === 'incoming' ? edge.from : edge.to
    const node = props.snapshot.nodes.find((/* 当前图中的真实节点。 */ item) => /* 找到该边的另一端。 */ item.id === otherId)
    return node ? [{ edge, node }] : []
  })
}

function inspectorLoad(): void {
  // 展示当前保存内容；证明尚未配对时基线保持未知，后续就绪再允许编辑。
  draft.value = selected.value ? JSON.parse(JSON.stringify(selected.value.payload)) as GraphPayload : null
  basePayload.value = JSON.stringify(draft.value)
  baseVersion.value = proofReady.value && props.branch ? props.branch.version : null
  pendingPayload.value = null
}
watch(() => /* 内容、选择与证明就绪必须一起触发草稿基线更新。 */
  [props.snapshot.mapId, props.selectedId, props.snapshot.revision, props.branch?.version ?? null, proofReady.value] as const, (
  /* 当前公开的图、选择、内容版本、证明与就绪状态。 */ current,
  /* 上次已展示的同一组公开状态，初次运行时不存在。 */ previous,
) => {
  // 自己的保存只有在新证明就绪后重建基线；真正外部冲突保持原草稿和原 version。
  if (!previous || current[0] !== previous[0] || current[1] !== previous[1]) {
    if (previous && current[0] === previous[0] && current[1] === null && previous[1] !== null && dirty.value
      && !props.snapshot.nodes.some((/* 新快照中的真实节点。 */ node) => /* 删除与用户主动清空仍存在的节点区分。 */ node.id === previous[1])) {
      pendingPayload.value = null
      return
    }
    inspectorLoad()
    return
  }
  if (!proofReady.value) {
    if (!dirty.value) inspectorLoad()
    return
  }
  const saved = JSON.stringify(selected.value?.payload ?? null)
  if (!dirty.value || (pendingPayload.value === serialized.value && saved === pendingPayload.value)) inspectorLoad()
}, { immediate: true })
watch(transitions, list => {
  if (!list.some(item => definitionKey(item) === transitionKey.value)) transitionKey.value = list[0] ? definitionKey(list[0]) : ''
}, { immediate: true })

function inspectorSave(): void {
  // 只提交用户建立草稿时的基线 version，不因新的证明到达自动升级脏稿。
  const node = selected.value
  if (!node || !draft.value || !canSave.value || versionChanged.value || !props.branch || baseVersion.value === null) return
  pendingPayload.value = serialized.value
  emit('save', { branch: { rootIds: [...props.branch.scope.rootIds], expectedVersion: baseVersion.value }, nodeId: node.id, typeId: node.typeId, typeVersion: node.typeVersion, payload: JSON.parse(JSON.stringify(draft.value)) as GraphPayload })
}
function inspectorRemove(): void {
  if (!selected.value || !editable.value || dirty.value || versionChanged.value || !props.branch || baseVersion.value === null) return
  emit('remove', { branch: { rootIds: [...props.branch.scope.rootIds], expectedVersion: baseVersion.value }, nodeId: selected.value.id })
}
function inspectorOpenRun(): void {
  // 只发当前保存节点和精确转换的开窗意图，模式、选材及最终确认由统一表单负责。
  const node = selected.value, selectedTransition = transition.value
  if (!node || !selectedTransition || !props.canEdit || props.busy || dirty.value || activeRun.value) return
  emit('run', { workspaceId: props.snapshot.workspaceId, mapId: props.snapshot.mapId, nodeId: node.id,
    transitionRef: { id: selectedTransition.id, version: selectedTransition.version } })
}
function inspectorEditEvidence(): void {
  // 正文草稿先处理，再固定当前消费者版本交给页面打开引用编辑窗口。
  const node = selected.value
  if (!node || !props.libraryAvailable || !props.canEdit || props.busy || dirty.value || versionChanged.value || activeRun.value) return
  emit('editEvidence', { mapId: props.snapshot.mapId, nodeId: node.id, expectedNodeRevision: node.revision })
}
function inspectorCreateChild(
  /* 按父定义列出的精确后继，组件不接受任意端点或边类型。 */ childType: { id: string; version: number },
): void {
  // 正文草稿先处理，父节点身份固定交给页面建立一次原子创建意图。
  if (!selected.value || !props.canEdit || props.busy || dirty.value || versionChanged.value || activeRun.value) return
  emit('child', { parentId: selected.value.id, childType })
}
</script>

<template>
  <section class="node-inspector" aria-label="数据详情">
    <header class="inspector-header"><div><h2>{{ selected ? graphReadNodeType(selected, catalog) : '数据详情' }}</h2><small v-if="selected" :title="`${selected.typeId}@${selected.typeVersion}${branch ? ` · ${branch.version}` : ''}`">类型版本 {{ selected.typeVersion }} · 内容版本 {{ selected.revision }} · {{ nodeReadOrigin(selected) }}</small></div><span v-if="dirty" class="draft-tag">未保存</span></header>
    <div v-if="!selected && !draft" class="inspector-empty">选择一个数据节点查看内容、关系和可用转换。</div>
    <div v-else class="inspector-content">
      <div v-if="versionChanged || (!selected && draft)" class="conflict-notice" role="status">
        <strong>{{ selected ? '服务器数据已变化，草稿已保留。' : '这个节点已不在当前图中，草稿已保留。' }}</strong>
        <p>重新载入会丢弃草稿。请先复制需要保留的内容，再载入服务器当前版本并重新编辑。</p>
        <div class="button-row"><button type="button" :disabled="busy" @click="inspectorLoad">重新载入</button></div>
      </div>
      <p v-if="activeRun" class="context-note">当前运行使用固定版本输入；运行结束后可继续修改数据。</p>
      <p v-else-if="!canEdit" class="context-note">当前为只读权限。</p>
      <p v-else-if="selected && branchLoading && !branch" class="context-note">正在读取这个分支的版本…</p>
      <p v-else-if="selected && !branch" class="field-error">无法取得这个分支的版本，内容保持只读。</p>
      <p v-else-if="selected && !definition" class="field-error">找不到这个节点的精确类型定义，内容保持只读。</p>
      <div v-else-if="leasesRequired && selected && branch && !activeRun" class="button-row lease-row">
        <button v-if="!owned" type="button" :disabled="busy" @click="emit('claim')">{{ branchOwner ? '尝试领取分支编辑权' : '领取分支编辑权' }}</button>
        <button v-else-if="owned" type="button" :disabled="busy" @click="emit('release')">释放分支编辑权</button>
        <span v-if="!owned && branchOwner" class="context-note">此分支正由其他客户端或运行任务占用，当前只读。</span>
      </div>

      <form v-if="draft && definition" class="node-form" @submit.prevent="inspectorSave">
        <DataPayloadEditor :schema="definition.schema" :field-labels="definition.presentation?.fieldLabels" :enum-labels="definition.presentation?.enumLabels" :references="definition.references" :nodes="snapshot.nodes" :catalog="catalog" :model-value="draft" :disabled="!editable" @update:model-value="draft = $event as GraphPayload" />
        <div v-if="canEdit" class="button-row"><button class="primary" type="submit" :disabled="!canSave || !dirty || versionChanged">保存数据</button><button type="button" :disabled="busy || !dirty" @click="inspectorLoad">恢复已保存内容</button></div>
      </form>
      <pre v-else-if="draft" class="payload-json">{{ JSON.stringify(draft, null, 2) }}</pre>

      <NodeProvenance v-if="selected" :node="selected" :workspace-id="snapshot.workspaceId" :map-id="snapshot.mapId" :history-available="historyAvailable === true" @open-operation="emit('openOperation', $event)" />

      <section v-if="selected" class="detail-section" aria-label="所用固定证据">
        <div class="relation-heading"><h3>所用固定证据</h3><button type="button" :disabled="!libraryAvailable || !canEdit || busy || dirty || versionChanged || activeRun" @click="inspectorEditEvidence">编辑所用证据</button></div>
        <p v-if="!libraryAvailable" class="context-note">当前服务未提供证据库；已有引用和理由保留。</p>
        <p v-else-if="dirty" class="context-note">请先保存或恢复正文草稿，再编辑所用证据。</p>
        <p v-if="!selected.libraryClaimRefs?.length" class="context-note">尚未引用固定证据。</p>
        <article v-for="(reference, index) in selected.libraryClaimRefs" :key="`${reference.entryId}:${reference.contentDigest}`" class="node-evidence">
          <strong :title="`固定条目：${reference.entryId} · 内容摘要：${reference.contentDigest}`">固定证据 {{ index + 1 }}</strong>
          <p>{{ reference.reason }}</p>
          <button type="button" :aria-label="`查看固定证据 ${index + 1}`" :disabled="!libraryAvailable || busy" @click="emit('openEvidence', { workspaceId: snapshot.workspaceId, ref: { entryId: reference.entryId, contentDigest: reference.contentDigest } })">查看固定证据</button>
        </article>
      </section>

      <section v-if="selected" class="detail-section">
        <div class="relation-heading">
          <h3>数据关系</h3>

        </div>
        <div v-if="successorTypes.length" class="button-row"><button v-for="type in successorTypes" :key="definitionKey(type)" type="button" :disabled="!canEdit || busy || dirty || versionChanged || activeRun" @click="inspectorCreateChild(type)">新增{{ type.title }}</button></div>
        <p v-if="dirty" class="context-note">请先保存或恢复正文草稿，再新增后继。</p>
        <p v-else-if="!incoming.length && !outgoing.length" class="context-note">这个节点还没有显式关系。</p>
        <article v-for="item in incoming" :key="`in:${item.edge.id}`" class="relation">
          <span>{{ item.edge.kind === 'successor' ? '前置' : '引用自' }}</span>
          <strong>{{ graphReadNodeType(item.node, catalog) }}</strong>
          <small>{{ graphReadNodeText(item.node, catalog) }}</small>
          <p v-if="item.edge.label">{{ item.edge.label }}</p>

        </article>
        <article v-for="item in outgoing" :key="`out:${item.edge.id}`" class="relation">
          <span>{{ item.edge.kind === 'successor' ? '后继' : '引用' }}</span>
          <strong>{{ graphReadNodeType(item.node, catalog) }}</strong>
          <small>{{ graphReadNodeText(item.node, catalog) }}</small>
          <p v-if="item.edge.label">{{ item.edge.label }}</p>

        </article>
      </section>

      <section v-if="selected && canEdit" class="detail-section">
        <h3>运行转换</h3>
        <p v-if="!transitions.length" class="context-note">当前类型没有可直接启动的转换。</p>
        <template v-else>
          <label class="field"><span>转换</span><select v-model="transitionKey" :disabled="busy || activeRun"><option v-for="item in transitions" :key="definitionKey(item)" :value="definitionKey(item)">{{ item.title }}</option></select></label>
          <p v-if="transition?.description" class="context-note">{{ transition.description }}</p>
          <p v-if="dirty" class="context-note">请先保存数据草稿，再开始处理。</p>
          <button class="primary run-button" type="button" :disabled="busy || activeRun || dirty" @click="inspectorOpenRun">配置并运行 {{ transition?.title }}</button>
        </template>
      </section>
      <footer v-if="selected && canEdit" class="inspector-footer"><button class="danger-button" type="button" :disabled="!editable || dirty || versionChanged" @click="inspectorRemove">删除节点</button></footer>
    </div>
  </section>
</template>

<style scoped>
.node-evidence{display:grid;gap:6px;border-left:2px solid var(--border);padding:8px 10px;font-size:12px}.node-evidence p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.node-evidence button{justify-self:start;font-size:11px;padding:4px 6px}
.relation-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.detail-section .button-row button { padding: 5px 8px; min-height: 28px; font-size: 11px; }
.relation p { font-size: 12px; overflow-wrap: anywhere; }
.node-inspector{min-width:0;background:var(--bg-panel)}.inspector-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border-subtle)}.inspector-header>div{min-width:0}.inspector-header small{display:block;margin-top:3px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis}h2{font-size:14px;font-weight:600}h3{font-size:12px;font-weight:600}.draft-tag{color:var(--warning);font-size:11px}.inspector-empty{padding:22px 16px;color:var(--text-muted);line-height:1.7}.inspector-content{padding:12px 14px}.node-form{display:grid;gap:12px}.button-row{display:flex;flex-wrap:wrap;gap:6px}.lease-row{margin-bottom:10px;align-items:center}.detail-section{border-top:1px solid var(--border-subtle);margin-top:16px;padding-top:14px;display:grid;gap:10px}.context-note{font-size:11px;color:var(--text-muted);line-height:1.6}.field{display:grid;gap:6px;font-size:12px}.field>span{color:var(--text-muted)}.field select{padding:6px 8px;min-height:30px}.check-row{display:flex;align-items:center;gap:6px;font-size:11px}.run-button{width:100%;min-height:32px}.field-error{color:var(--danger);font-size:11px;line-height:1.5}.payload-json{padding:10px;background:var(--bg-input);border:1px solid var(--border-subtle);white-space:pre-wrap;overflow-wrap:anywhere}.relation{display:grid;gap:3px;text-align:left;padding:8px;border:1px solid var(--border-subtle);background:var(--flow-node-bg);color:inherit}.relation span,.relation small{color:var(--text-muted);font-size:11px}.relation small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.conflict-notice{padding:10px;margin-bottom:12px;border:1px solid var(--warning);background:var(--bg-warning);line-height:1.6}.conflict-notice p{margin:5px 0 8px;font-size:11px}.inspector-footer{border-top:1px solid var(--border-subtle);margin-top:18px;padding-top:12px}.danger-button{color:var(--danger);background:transparent}
</style>
