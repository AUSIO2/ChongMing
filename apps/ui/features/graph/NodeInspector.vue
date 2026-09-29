<!-- 通用数据详情：用精确类型定义编辑 payload，并从可用转换启动有限运行计划。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { GraphBranchGrant, GraphBranchProof, GraphBranchSnapshot, GraphPayload, GraphSnapshot } from '../../../../contracts/graph'
import DataPayloadEditor from './DataPayloadEditor.vue'
import { graphCreateRunPlan, graphReadAvailableTransitions, graphReadNodeText, graphReadNodeType } from './graph-layout'
import { definitionKey, payloadFindType } from './data-payload'

const props = defineProps<{ snapshot: GraphSnapshot; branch: GraphBranchSnapshot | null; grant: GraphBranchGrant | null; branchLoading: boolean; catalog: DefinitionCatalog | null; selectedId: string | null; canEdit: boolean; busy: boolean; leasesRequired: boolean }>()
const emit = defineEmits<{
  save: [input: { branch: GraphBranchProof; nodeId: string; typeId: string; typeVersion: number; payload: GraphPayload }]
  remove: [input: { branch: GraphBranchProof; nodeId: string }]
  run: [input: { scope: { nodeIds: string[] }; plan: ReturnType<typeof graphCreateRunPlan>; mode: 'auto' | 'human-in-loop'; regenerate: boolean }]
  claim: []
  release: []
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
const branchOwner = computed(() => props.branch && (props.snapshot.ownerships ?? []).find(ownership =>
  (ownership.kind === 'run' || ownership.expiresAt !== null && Date.parse(ownership.expiresAt) > Date.now())
  && ownership.scope.nodeIds.some(id => props.branch!.scope.nodeIds.includes(id))))
const editable = computed(() => props.canEdit && !props.busy && !activeRun.value && owned.value && !!selected.value && !!definition.value && !!props.branch)
const draft = ref<GraphPayload | null>(null)
const basePayload = ref('')
const baseVersion = ref<string | null>(null)
const pendingPayload = ref<string | null>(null)
const mode = ref<'auto' | 'human-in-loop'>('human-in-loop')
const regenerate = ref(false)
const transitionKey = ref('')
const serialized = computed(() => JSON.stringify(draft.value))
const dirty = computed(() => draft.value !== null && serialized.value !== basePayload.value)
const versionChanged = computed(() => dirty.value && (!props.branch || baseVersion.value !== props.branch.version))
const transitions = computed(() => selected.value ? graphReadAvailableTransitions([selected.value], props.catalog) : [])
const transition = computed(() => transitions.value.find(item => definitionKey(item) === transitionKey.value) ?? transitions.value[0])
const outgoing = computed(() => selected.value ? props.snapshot.edges.filter(edge => edge.from === selected.value!.id)
  .map(edge => ({ edge, node: props.snapshot.nodes.find(node => node.id === edge.to) })).filter(item => !!item.node) : [])
const incoming = computed(() => selected.value ? props.snapshot.edges.filter(edge => edge.to === selected.value!.id)
  .map(edge => ({ edge, node: props.snapshot.nodes.find(node => node.id === edge.from) })).filter(item => !!item.node) : [])

function inspectorLoad(): void {
  draft.value = selected.value ? structuredClone(selected.value.payload) : null
  basePayload.value = JSON.stringify(draft.value)
  baseVersion.value = props.branch?.version ?? null
  pendingPayload.value = null
}
watch(() => [props.snapshot.mapId, props.selectedId, props.snapshot.revision, props.branch?.version ?? null] as const, (current, previous) => {
  if (!previous || current[0] !== previous[0] || current[1] !== previous[1]) { inspectorLoad(); return }
  const saved = JSON.stringify(selected.value?.payload ?? null)
  if (!dirty.value || (pendingPayload.value === serialized.value && saved === pendingPayload.value)) inspectorLoad()
}, { immediate: true })
watch(transitions, list => {
  if (!list.some(item => definitionKey(item) === transitionKey.value)) transitionKey.value = list[0] ? definitionKey(list[0]) : ''
}, { immediate: true })

function inspectorSave(): void {
  const node = selected.value
  if (!node || !draft.value || !editable.value || versionChanged.value || !props.branch || baseVersion.value === null) return
  pendingPayload.value = serialized.value
  emit('save', { branch: { rootIds: [...props.branch.scope.rootIds], expectedVersion: baseVersion.value }, nodeId: node.id, typeId: node.typeId, typeVersion: node.typeVersion, payload: structuredClone(draft.value) })
}
function inspectorRemove(): void {
  if (!selected.value || !editable.value || dirty.value || versionChanged.value || !props.branch || baseVersion.value === null) return
  emit('remove', { branch: { rootIds: [...props.branch.scope.rootIds], expectedVersion: baseVersion.value }, nodeId: selected.value.id })
}
function inspectorStartRun(): void {
  const node = selected.value, selectedTransition = transition.value
  if (!node || !selectedTransition || !props.canEdit || props.busy || dirty.value || activeRun.value) return
  emit('run', { scope: { nodeIds: [node.id] }, plan: graphCreateRunPlan(selectedTransition, [node.id]), mode: mode.value, regenerate: regenerate.value })
}
</script>

<template>
  <section class="node-inspector" aria-label="数据详情">
    <header class="inspector-header"><div><h2>{{ selected ? graphReadNodeType(selected, catalog) : '数据详情' }}</h2><small v-if="selected">{{ selected.typeId }}@{{ selected.typeVersion }}<template v-if="branch"> · 分支 {{ branch.version.slice(0, 10) }}</template></small></div><span v-if="dirty" class="draft-tag">未保存</span></header>
    <div v-if="!selected && !draft" class="inspector-empty">选择一个数据节点查看内容、关系和可用转换。</div>
    <div v-else class="inspector-content">
      <div v-if="versionChanged || (!selected && draft)" class="conflict-notice" role="status">
        <strong>{{ selected ? '服务器数据已变化，草稿已保留。' : '这个节点已不在当前图中，草稿已保留。' }}</strong>
        <p>重新载入会丢弃草稿。请先复制需要保留的内容，再载入服务器当前版本并重新编辑。</p>
        <div class="button-row"><button type="button" :disabled="busy" @click="inspectorLoad">重新载入</button></div>
      </div>
      <p v-if="activeRun" class="context-note">当前运行使用冻结输入；运行结束后可继续修改数据。</p>
      <p v-else-if="!canEdit" class="context-note">当前为只读权限。</p>
      <p v-else-if="selected && branchLoading && !branch" class="context-note">正在读取这个分支的版本…</p>
      <p v-else-if="selected && !branch" class="field-error">无法取得这个分支的版本，内容保持只读。</p>
      <p v-else-if="selected && !definition" class="field-error">找不到这个节点的精确类型定义，内容保持只读。</p>
      <div v-else-if="leasesRequired && selected && branch && !activeRun" class="button-row lease-row">
        <button v-if="!owned" type="button" :disabled="busy" @click="emit('claim')">{{ branchOwner ? '尝试领取分支编辑权' : '领取分支编辑权' }}</button>
        <button v-else-if="owned" type="button" :disabled="busy" @click="emit('release')">释放分支编辑权</button>
        <span v-if="!owned && branchOwner" class="context-note">此分支正由其他客户端或 Run 占用，当前只读。</span>
      </div>

      <form v-if="draft && definition" class="node-form" @submit.prevent="inspectorSave">
        <DataPayloadEditor :schema="definition.schema" :model-value="draft" :disabled="!editable" @update:model-value="draft = $event as GraphPayload" />
        <div v-if="canEdit" class="button-row"><button class="primary" type="submit" :disabled="!editable || !dirty || versionChanged">保存数据</button><button type="button" :disabled="busy || !dirty" @click="inspectorLoad">恢复已保存内容</button></div>
      </form>
      <pre v-else-if="draft" class="payload-json">{{ JSON.stringify(draft, null, 2) }}</pre>

      <section v-if="selected && (incoming.length || outgoing.length)" class="detail-section">
        <h3>数据关系</h3>
        <article v-for="item in incoming" :key="`in:${item.edge.id}`" class="relation">
          <span>{{ item.edge.kind === 'successor' ? '前置' : '引用自' }}</span><strong>{{ graphReadNodeType(item.node!, catalog) }}</strong><small>{{ graphReadNodeText(item.node!, catalog) }}</small>
        </article>
        <article v-for="item in outgoing" :key="`out:${item.edge.id}`" class="relation"><span>{{ item.edge.kind === 'successor' ? '后继' : '引用' }}</span><strong>{{ graphReadNodeType(item.node!, catalog) }}</strong><small>{{ graphReadNodeText(item.node!, catalog) }}</small></article>
      </section>

      <section v-if="selected && canEdit" class="detail-section">
        <h3>运行转换</h3>
        <p v-if="!transitions.length" class="context-note">当前类型没有可直接启动的转换。</p>
        <template v-else>
          <label class="field"><span>转换</span><select v-model="transitionKey" :disabled="busy || activeRun"><option v-for="item in transitions" :key="definitionKey(item)" :value="definitionKey(item)">{{ item.title }}</option></select></label>
          <p v-if="transition?.description" class="context-note">{{ transition.description }}</p>
          <label class="field"><span>处理方式</span><select v-model="mode" :disabled="busy || activeRun"><option value="human-in-loop">需要审核时由人工确认</option><option value="auto">自动处理</option></select></label>
          <label class="check-row"><input v-model="regenerate" type="checkbox" :disabled="busy || activeRun">重新生成已有结果</label>
          <p v-if="dirty" class="context-note">请先保存数据草稿，再开始处理。</p>
          <button class="primary run-button" type="button" :disabled="busy || activeRun || dirty" @click="inspectorStartRun">开始 {{ transition?.title }}</button>
        </template>
      </section>
      <footer v-if="selected && canEdit" class="inspector-footer"><button class="danger-button" type="button" :disabled="!editable || dirty || versionChanged" @click="inspectorRemove">删除节点</button></footer>
    </div>
  </section>
</template>

<style scoped>
.node-inspector{min-width:0;background:var(--bg-panel)}.inspector-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border-subtle)}.inspector-header>div{min-width:0}.inspector-header small{display:block;margin-top:3px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis}h2{font-size:14px;font-weight:600}h3{font-size:12px;font-weight:600}.draft-tag{color:var(--warning);font-size:11px}.inspector-empty{padding:22px 16px;color:var(--text-muted);line-height:1.7}.inspector-content{padding:12px 14px}.node-form{display:grid;gap:12px}.button-row{display:flex;flex-wrap:wrap;gap:6px}.lease-row{margin-bottom:10px;align-items:center}.detail-section{border-top:1px solid var(--border-subtle);margin-top:16px;padding-top:14px;display:grid;gap:10px}.context-note{font-size:11px;color:var(--text-muted);line-height:1.6}.field{display:grid;gap:6px;font-size:12px}.field>span{color:var(--text-muted)}.field select{padding:6px 8px;min-height:30px}.check-row{display:flex;align-items:center;gap:6px;font-size:11px}.run-button{width:100%;min-height:32px}.field-error{color:var(--danger);font-size:11px;line-height:1.5}.payload-json{padding:10px;background:var(--bg-input);border:1px solid var(--border-subtle);white-space:pre-wrap;overflow-wrap:anywhere}.relation{display:grid;gap:3px;text-align:left;padding:8px;border:1px solid var(--border-subtle);background:var(--flow-node-bg);color:inherit}.relation span,.relation small{color:var(--text-muted);font-size:11px}.relation small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.conflict-notice{padding:10px;margin-bottom:12px;border:1px solid var(--warning);background:#fff8e9;line-height:1.6}.conflict-notice p{margin:5px 0 8px;font-size:11px}.inspector-footer{border-top:1px solid var(--border-subtle);margin-top:18px;padding-top:12px}.danger-button{color:var(--danger);background:transparent}
</style>
