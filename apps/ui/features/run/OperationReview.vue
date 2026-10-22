<!-- 按权威发布清单核对候选、输入版本和冻结证据，提交已展示版本的审核决定。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ClientGateway, CommandInputMap } from '../../../../contracts/client'
import type { DefinitionRef } from '../../../../contracts/data-definition'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphProposedOutput, GraphPublicationItem, GraphStageResult, GraphOperation, GraphRun } from '../../../../contracts/graph-run'
import { uiReadErrorMessage, uiReadPort, uiReadStage } from '../../presentation/ui-labels'
import { evidenceReadBasis, evidenceReadJudgment, evidenceReadScope, evidenceReadStatus } from '../evidence-library/evidence-presentation'
import { graphReadOperationLabel, graphReadOperationProgress } from '../graph/graph-layout'
import type { OperationOriginTarget } from '../graph/node-origin'
import DataPayloadView from '../reader/DataPayloadView.vue'
import { readerReadFieldLabel, readerReadFields } from '../reader/reader-content'
import {
  reviewReadCandidateUses, reviewReadFrozenMaterials, reviewReadInputVersions,
  usePublicationPreview, type PublicationPreviewContext,
} from './publication-preview'
import { runHasPendingReview } from './run-progress'

const props = withDefaults(defineProps<{
  snapshot: GraphSnapshot
  run: GraphRun
  operation: GraphOperation
  gateway: ClientGateway
  identity: Pick<PublicationPreviewContext, 'userId' | 'connectionKey' | 'workspaceId'>
  previewSupported: boolean
  canEdit: boolean
  canControl: boolean
  busy: boolean
  readOnly?: boolean
  historyAvailable?: boolean
}>(), { readOnly: false })
const emit = defineEmits<{
  answer: [input: Omit<CommandInputMap['review.answer'], 'control'>]
  refresh: []
  unauthorized: []
  openOperation: [target: OperationOriginTarget]
}>()
const previewContext = computed<PublicationPreviewContext>(() =>
  /* 每项只读状态跟随当前会话及审核，不借用另一个组件的预览。 */ ({
    ...props.identity, snapshot: props.snapshot, run: props.run, operation: props.readOnly ? null : props.operation, supported: props.previewSupported,
  }))
const publication = usePublicationPreview(props.gateway, previewContext, () => {
  // 状态模块已确认认证失败仍属于当前读取，再交给会话结束连接。
  emit('unauthorized')
})
const showOtherCandidates = ref(false)
const reused = computed(() => /* 复用处理项沿用保存结果，不代表再次生成或审核。 */ props.operation.reusedFromOperationId !== undefined)
const review = computed(() => /* 审核决定必须对应当前保存的审核身份。 */ props.operation.review)
const pending = computed(() => /* 终态Run保留原审核记录，但不再产生可提交审核的入口。 */
  !props.readOnly && runHasPendingReview(props.run, props.operation))
const pendingResult = computed(() => /* 只有结果审核使用权威发布预览。 */ pending.value && review.value?.kind === 'result')
const inputs = computed(() => /* 不用当前正文冒充本次运行使用的旧版本。 */ reviewReadInputVersions(props.snapshot, props.operation))
const materials = computed(() => /* 完整正文仅来自当前步骤获权的冻结集合。 */ reviewReadFrozenMaterials(props.run, props.operation))
const inputSections = computed(() => /* 输入和上下文分别核对，二者都可保留原文可读边界。 */ [
  { title: '输入材料', rows: inputs.value.input }, { title: '上下文材料', rows: inputs.value.context },
])
const stages = computed(() => /* 进度来自冻结阶段和已接纳结果，不由预览推测执行状态。 */ props.operation.stages.map(
  (/* 当前步骤保存的阶段组。 */ group) => {
    // 保留动态槽位的真实智能体名称。
    const spec = props.operation.executionSpec.stages.find((/* 冻结的阶段模板。 */ stage) => /* 按阶段身份对应。 */ stage.id === group.stageId)
    const agentNames = [...new Set(group.planSlots.map((/* 已接纳规划中的槽位。 */ slot) =>
      /* 读取精确版本的智能体配置名称。 */ props.run.agents.find((/* 冻结智能体配置。 */ agent) =>
        /* 相同id的其它版本不能替代此槽位。 */ agent.ref.id === slot.agentRef.id && agent.ref.version === slot.agentRef.version)?.profile.name ?? slot.agentRef.id))]
    return { group, spec, agentNames }
  },
))
const planResults = computed(() => /* 保存全部规划说明，待审核规划仍采用原批准合同。 */ props.operation.stages.flatMap(
  (/* 保存已接纳结果的阶段。 */ stage) => /* 只取规划结果。 */ stage.results.filter(
    (/* 阶段内的一份结果。 */ result): result is Extract<GraphStageResult, { mode: 'plan' }> => /* 按模式缩窄。 */ result.mode === 'plan',
  ),
))
const selectionResults = computed(() => /* 不再以最后一份选择数量冒充最终发布集合。 */ props.operation.stages.flatMap(
  (/* 保存已接纳结果的阶段。 */ stage) => /* 所有选择说明都可读。 */ stage.results.filter(
    (/* 阶段内的一份结果。 */ result): result is Extract<GraphStageResult, { mode: 'selection' }> => /* 按模式缩窄。 */ result.mode === 'selection',
  ),
))
const savedCandidates = computed(() => /* 候选正文保留生成说明与原始稳定键，不分配新的节点身份。 */ props.operation.stages.flatMap(
  (/* 保存已接纳候选的阶段。 */ stage) => /* 遍历真实outputs结果。 */ stage.results.flatMap((/* 当前阶段的一份已接纳结果。 */ result) =>
    /* 规划与选择本身不包含候选正文。 */ result.mode === 'outputs' ? result.outputs.map((/* 模型已接纳的候选。 */ output) =>
      /* 将候选与真实生成上下文保存在一起。 */ ({ output, result })) : []),
))
const knownPublication = computed(() => /* 待审核清单须成功对齐，终态清单只认已保存outputRefs。 */
  publication.state.value.status === 'ready' || props.operation.status === 'completed')
const published = computed(() => {
  // 待结果审核只用服务器集合；终态只解释实际产物，不查询待审核接口。
  const state = publication.state.value
  if (state.status === 'ready') return state.published.map(
    (/* 已核对的服务端发布项及其保存正文。 */ row) => /* 将服务端发布原因带入只读显示。 */ reviewPresentCandidate(row.output, row.result, row.item),
  )
  if (props.operation.status !== 'completed') return []
  return savedCandidates.value.filter((/* 当前保存的候选。 */ row) => /* 只有真实产物键才属于历史发布。 */
    props.operation.outputRefs.some((/* 已发布产物的稳定映射。 */ output) =>
      /* 不用当前节点正文替代发布时保存候选。 */ output.workId === row.result.workId && output.key === row.output.key && output.port === row.output.port))
    .map((/* 原产物对应的保存候选。 */ row) => /* 终态不补造直接入选或连带原因。 */ reviewPresentCandidate(row.output, row.result))
})
const otherCandidates = computed(() => {
  // 预览不可用时只称已接纳候选，不把它们当成确定未入选或将发布。
  const keys = new Set(published.value.map((/* 已发布或权威将发布的展示项。 */ row) => /* 保存完整组合键。 */ row.key))
  return savedCandidates.value.filter((/* 当前保存的候选。 */ row) =>
    /* 只将真实发布集合之外的候选放入折叠区。 */ !keys.has(JSON.stringify([row.result.workId, row.output.key])))
    .map((/* 要折叠的候选及生成上下文。 */ row) => /* 全部候选共用同一正文呈现。 */ reviewPresentCandidate(row.output, row.result))
})
const candidateSections = computed(() => {
  // 历史复用产物与新发布分开命名，两类列表仍共用候选正文渲染。
  let publicationTitle = '已发布结果'
  if (reused.value) publicationTitle = '复用的历史产物'
  else if (pendingResult.value) publicationTitle = '本次将发布'
  let otherTitle = knownPublication.value ? '未入选候选' : '已接纳候选'
  if (reused.value) otherTitle = '复用的历史候选'
  return [
  { key: 'publication', title: publicationTitle,
    visible: pendingResult.value || props.operation.status === 'completed', rows: published.value, collapsed: false },
  { key: 'other', title: otherTitle,
    visible: otherCandidates.value.length > 0, rows: otherCandidates.value, collapsed: !showOtherCandidates.value },
  ]
})
const materialViews = computed(() => /* 库判断、范围和收录理由都读取冻结材料，不发当前库查询。 */ materials.value.map(
  (/* 当前步骤保存的完整固定证据。 */ material) => /* 复用现有字段及四类依据展示。 */ ({ material,
    fields: readerReadFields(material.entry.claim.nodeSnapshot, material.definition),
    scope: evidenceReadScope(material.entry.applicability), basis: evidenceReadBasis(material.entry.decision.basisRefs),
  }),
))
const approvablePreview = computed(() => {
  // 预览、版本正文和实际引用都可核对时才开放本次结果批准。
  const state = publication.state.value
  if (state.status !== 'ready') return null
  if ([...inputs.value.input, ...inputs.value.context].some((/* 本次输入或上下文。 */ item) => /* 错版与缺失正文不能充当已核对材料。 */ item.state !== 'matched')) return null
  if (materials.value.length !== (props.operation.executionSpec.libraryClaimRefs?.length ?? 0)) return null
  return published.value.every((/* 本次实际发布的候选。 */ row) => /* 实际引用必须能对应到冻结材料。 */
    row.uses.every((/* 一条候选本次使用声明。 */ use) => /* 不以当前库补缺失的历史材料。 */ use.material !== null)) ? state.preview : null
})

function reviewReadDefinition(
  /* 当前保存候选或输入声明的精确类型。 */ type: DefinitionRef,
) {
  // 使用本Operation冻结的定义，不借用当前工作区后来发布的另一版本。
  return props.operation.executionSpec.dataTypes.find((/* 当前步骤冻结的一种数据类型。 */ item) =>
    /* 类型身份和版本必须同时对应。 */ item.id === type.id && item.version === type.version)
}

function reviewPresentCandidate(
  /* 已接纳且不可编辑的候选正文。 */ output: GraphProposedOutput,
  /* 该候选真实所属的生成结果。 */ result: Extract<GraphStageResult, { mode: 'outputs' }>,
  /* 仅当前权威预览提供的发布原因，历史产物不补造。 */ item?: GraphPublicationItem,
) {
  // 同一份候选显示用于实际发布和折叠列表，0评分和原引用理由完整保留。
  const definition = reviewReadDefinition(output.typeRef)
  const slot = props.operation.stages.find((/* 当前候选所属的阶段。 */ stage) => /* 定位阶段保存的槽位。 */ stage.stageId === result.stageId)
    ?.planSlots.find((/* 已接纳规划的槽位。 */ current) => /* 取实际执行者。 */ current.id === result.slotId)
  const agent = props.run.agents.find((/* Run冻结的智能体。 */ current) =>
    /* 优先取槽位精确版本。 */ current.ref.id === slot?.agentRef.id && current.ref.version === slot.agentRef.version)
    ?? props.operation.executionSpec.stages.find((/* 阶段冻结模板。 */ current) => /* 默认阶段执行者。 */ current.id === result.stageId)?.agent
  return { key: JSON.stringify([result.workId, output.key]), output, result, item,
    title: definition?.title ?? `未知类型（${output.typeRef.id}@${output.typeRef.version}）`,
    fields: readerReadFields({ payload: output.payload }, definition), agentName: agent?.profile.name ?? result.slotId,
    uses: reviewReadCandidateUses(output, materials.value) }
}

function reviewAnswer(
  /* 用户对当前审核的整项决定。 */ decision: 'approve' | 'reject',
): void {
  // 固定已展示的预览版本后使本地版本失效；原请求确认由会话submit/retry负责。
  const current = review.value
  if (props.readOnly || !current || !pending.value || !props.canEdit || !props.canControl || props.busy) return
  let version: string | undefined
  if (current.kind === 'result' && decision === 'approve') {
    const preview = approvablePreview.value
    if (!preview) return
    version = preview.publicationVersion
    publication.invalidate()
  }
  emit('answer', { mapId: props.snapshot.mapId, runId: props.run.id, operationId: props.operation.id,
    reviewId: current.id, expectedReviewRevision: current.revision, decision,
    ...(version === undefined ? {} : { expectedPublicationVersion: version }) })
}

function reviewReload(): void {
  // 同时请求会话刷新审核事实；快照变化时状态模块会取消本次旧身份读取。
  if (props.readOnly || props.busy) return
  emit('refresh')
  void publication.reload()
}

function reviewOpenReuse(): void {
  // 每次明确点击只查询直接来源，固定此处理项复制的规格及产物映射供核对。
  const operationId = props.operation.reusedFromOperationId
  if (!operationId || !props.historyAvailable) return
  emit('openOperation', { kind: 'reuse', operationId, source: {
    id: props.operation.id, transitionRef: { ...props.operation.transitionRef }, specHash: props.operation.specHash,
    outputRefs: props.operation.outputRefs.map((/* 复用处理项保存的完整产物映射。 */ output) =>
      /* 脱离界面响应式对象，后续导航不借用当前操作的新版映射。 */ ({ ...output })),
  } })
}
</script>

<template>
  <section class="run-review" :aria-label="`${graphReadOperationLabel(operation)}进度与审核`" :data-operation-id="operation.id">
    <header class="run-header">
      <h2>{{ graphReadOperationLabel(operation) }}</h2>
      <small>{{ operation.transitionRef.id }}@{{ operation.transitionRef.version }}</small>
    </header>
    <div class="run-content">
      <section v-if="reused" class="reuse-note" aria-label="复用历史结果">
        <h3>复用历史结果</h3>
        <p>本处理项沿用历史产物、执行计划和审核记录。节点仍保留原生成来源，以下记录不代表本次重新生成或人工批准。</p>
        <p>直接来源处理项：{{ operation.reusedFromOperationId }}</p>
        <button type="button" :disabled="!historyAvailable" @click="reviewOpenReuse">查看直接复用来源</button>
        <p v-if="!historyAvailable">当前服务未提供运行历史目录，暂不能定位直接来源。</p>
      </section>
      <section v-for="section in inputSections" :key="section.title" :aria-label="section.title" class="material-section">
        <h3>{{ section.title }}</h3>
        <p v-if="!section.rows.length" class="muted">本步骤没有{{ section.title }}。</p>
        <article v-for="row in section.rows" :key="row.ref.key" class="input-row">
          <strong>{{ uiReadPort(row.ref.port) }} · {{ reviewReadDefinition(row.ref.type)?.title ?? row.ref.type.id }}</strong>
          <p class="muted">本次使用版本 {{ row.ref.revision }}<template v-if="row.currentRevision !== null"> · 当前版本 {{ row.currentRevision }}</template></p>
          <p v-if="row.state !== 'matched'" class="warning">原版本正文不可用。{{ row.state === 'missing' ? '当前节点已不存在。' : '当前节点的类型或版本已变化。' }}</p>
          <DataPayloadView v-if="row.node" :fields="readerReadFields(row.node, reviewReadDefinition(row.ref.type))" />
          <details class="identity-details"><summary>材料身份</summary><p>{{ row.ref.id }} · {{ row.ref.type.id }}@{{ row.ref.type.version }} · {{ row.ref.key }}</p></details>
        </article>
      </section>
      <div class="run-status" :class="{ failed: operation.status === 'failed' }"><strong>{{ graphReadOperationProgress(operation) }}</strong></div>
      <p v-if="operation.status === 'failed'" class="muted">本项处理未完成，已经接纳的阶段结果仍保留。</p>

      <section class="progress-section" :aria-label="reused ? '复用的历史阶段' : '执行阶段'">
        <div class="section-heading"><h3>{{ reused ? '复用的历史阶段' : '执行阶段' }}</h3><span>{{ stages.filter(item => item.group.closed).length }} / {{ stages.length }}</span></div>
        <article v-for="item in stages" :key="item.group.stageId" class="stage-row">
          <div><strong>{{ uiReadStage(item.group.stageId) }}</strong><p>{{ item.agentNames.join('、') || item.spec?.agent.profile.name || '等待计划' }}</p></div>
          <span>{{ item.group.closed ? '已完成' : `${item.group.results.length} / ${item.group.expectedWorkIds.length || '待计划'}` }}</span>
        </article>
      </section>
      <section v-for="plan in planResults" :key="plan.workId" class="result-section" :aria-label="reused ? '复用的历史执行计划' : '执行计划'">
        <div class="section-heading"><h3>{{ reused ? '复用的历史执行计划' : '执行计划' }}</h3><span>{{ plan.plan.slots.length }} 个智能体任务</span></div>
        <p class="body-text">{{ plan.plan.reason }}</p>
        <article v-for="slot in plan.plan.slots" :key="slot.id" class="plan-row">
          <strong>{{ slot.angle || uiReadStage(slot.stageId) }}</strong><p>{{ slot.hint || '按阶段定义执行' }}</p>
          <small>{{ slot.agentRef.id }}@{{ slot.agentRef.version }} · {{ slot.tools.length ? slot.tools.join('、') : '不使用工具' }}</small>
        </article>
      </section>

      <template v-for="section in candidateSections" :key="section.key">
        <section v-if="section.visible" class="result-section" :aria-label="section.title">
          <div class="section-heading">
            <h3>{{ section.title }}</h3>
            <span v-if="section.key !== 'publication' || knownPublication">{{ section.rows.length }} 项</span>
          </div>
          <template v-if="section.key === 'publication' && pendingResult">
            <p v-if="publication.state.value.status === 'loading'" class="muted" role="status">正在读取权威发布预览…</p>
            <p v-else-if="publication.state.value.status === 'unsupported'" class="warning">当前服务未提供发布预览，请升级服务后再批准结果。</p>
            <template v-else-if="publication.state.value.status !== 'ready'">
              <p class="warning" role="status">{{ publication.error.value ? uiReadErrorMessage(publication.error.value.message) : '发布预览已失效，请重新读取并核对。' }}</p>
              <button type="button" :disabled="busy" @click="reviewReload">重新读取预览</button>
            </template>
          </template>
          <p v-if="section.key === 'publication' && operation.status === 'completed'" class="muted">{{ reused ? '以下为复用的历史候选正文；本次没有重新生成，正式节点的当前内容可能已变化。' : '以下为发布时保存的候选正文；正式节点的当前内容可能已变化。' }}</p>
          <button v-if="section.key === 'other'" class="text-action" type="button" :aria-expanded="showOtherCandidates" @click="showOtherCandidates = !showOtherCandidates">{{ showOtherCandidates ? '收起' : '查看' }}{{ section.title }}</button>
          <div v-if="!section.collapsed" class="candidate-list">
            <template v-for="port in operation.executionSpec.transition.ports.output" :key="port.name">
              <div v-if="section.rows.some(row => row.output.port === port.name)" class="port-group">
                <h4>{{ uiReadPort(port.name) }} · {{ section.rows.filter(row => row.output.port === port.name).length }} 项</h4>
                <details v-for="row in section.rows.filter(candidate => candidate.output.port === port.name)" :key="row.key" class="candidate-row">
                  <summary>
                    <strong>{{ row.title }}</strong>
                    <span v-if="row.item?.directlySelected" class="selection-label">直接入选</span>
                    <span v-if="row.item && !row.item.directlySelected" class="selection-label">连带发布</span>
                    <span v-if="row.item?.directlySelected && row.item.referencedBy.length" class="selection-label">同时被引用</span>
                  </summary>
                  <p class="muted">{{ uiReadStage(row.result.stageId) }} · {{ row.agentName }}</p>
                  <p class="body-text">{{ row.result.reason }}</p>
                  <DataPayloadView :fields="row.fields" />
                  <div v-if="row.item?.referencedBy.length" class="reference-list">
                    <strong>候选引用方</strong><p v-for="source in row.item.referencedBy" :key="JSON.stringify([source.workId, source.key])">{{ source.key }} · {{ source.workId }}</p>
                  </div>
                  <section v-if="row.uses.length" class="reference-list" aria-label="候选实际证据引用">
                    <h4>实际引用证据</h4>
                    <article v-for="use in row.uses" :key="use.ref.entryId">
                      <strong>{{ use.material ? evidenceReadJudgment(use.material.entry.confidence) : '冻结材料不可用' }}</strong>
                      <p class="body-text">本次使用理由：{{ use.ref.reason }}</p><small>{{ use.ref.entryId }}</small>
                    </article>
                  </section>
                  <details class="identity-details"><summary>候选身份</summary><p>{{ row.result.workId }} · {{ row.output.key }} · {{ row.output.typeRef.id }}@{{ row.output.typeRef.version }}</p></details>
                </details>
              </div>
            </template>
            <p v-if="!section.rows.length && knownPublication" class="muted">没有发布条目。</p>
          </div>
        </section>
      </template>
      <details v-if="selectionResults.length" class="selection-notes">
        <summary>{{ reused ? '复用的历史选择说明' : '阶段选择说明' }}</summary>
        <article v-for="result in selectionResults" :key="result.workId"><strong>{{ uiReadStage(result.stageId) }} · {{ result.selection.length }} 项</strong><p class="body-text">{{ result.reason }}</p></article>
      </details>

      <details class="execution-spec">
        <summary>冻结执行规格</summary>
        <p>规格摘要：{{ operation.specHash }}</p>
        <p>转换：{{ operation.executionSpec.transition.title }} · {{ operation.executionSpec.transition.id }} · v{{ operation.executionSpec.transition.version }}</p>
        <p v-for="stage in operation.executionSpec.stages" :key="stage.id">阶段 {{ uiReadStage(stage.id) }} · 智能体 {{ stage.agent.profile.name }} · {{ stage.agent.ref.id }} · v{{ stage.agent.ref.version }}</p>
        <p>这是当时保存的执行配置；模型调用次数、工具实际使用和完整展开提示正文未包含在此规格中。</p>
        <details><summary>完整执行规格 JSON</summary><pre>{{ JSON.stringify(operation.executionSpec, null, 2) }}</pre></details>
      </details>

      <section v-if="operation.executionSpec.libraryClaimRefs?.length" class="material-section" aria-label="本步骤冻结证据">
        <h3>本步骤冻结证据</h3>
        <p class="muted">审核显示完整冻结正文；智能体按冻结定义的字段白名单和可见项规则读取。</p>
        <p v-if="materials.length !== operation.executionSpec.libraryClaimRefs.length" class="warning">部分冻结材料不可用，请刷新后核对。</p>
        <details v-for="view in materialViews" :key="view.material.ref.entryId" class="frozen-row">
          <summary>{{ evidenceReadJudgment(view.material.entry.confidence) }}</summary>
          <p class="muted">启动时状态：{{ evidenceReadStatus(view.material.entry.status) }}</p>
          <DataPayloadView :fields="view.fields" />
          <h4>适用范围</h4><dl class="scope"><div v-for="row in view.scope" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div></dl>
          <h4>收录理由</h4><p class="body-text">{{ view.material.entry.decision.reason }}</p>
          <h4>收录依据</h4>
          <p v-if="!view.basis.length" class="muted">没有保存依据引用。</p>
          <article v-for="basis in view.basis" :key="basis.key"><small>{{ basis.label }}</small><p class="body-text">{{ basis.text }}</p></article>
          <details class="projection-details"><summary>智能体可读范围</summary>
            <p>字段白名单：{{ view.material.definition.agentProjection.include.map(path => readerReadFieldLabel(path, view.material.definition)).join('、') || '无' }}</p>
            <p v-for="filter in view.material.definition.agentProjection.mapEntryFilters" :key="filter.path">{{ readerReadFieldLabel(filter.path, view.material.definition) }}：仅包含“{{ readerReadFieldLabel(`${filter.path}/*/${filter.visibleWhen}`, view.material.definition) }}”为是的项目。</p>
            <p class="muted">这是获权读取范围，不能据此推断每次模型调用实际使用了哪些字段。</p>
          </details>
          <details class="identity-details"><summary>冻结身份与摘要</summary>
            <p>条目：{{ view.material.ref.entryId }}</p><p>内容摘要：{{ view.material.ref.contentDigest }}</p>
            <p>快照摘要：{{ view.material.snapshotDigest }}</p>
            <p>数据类型：{{ view.material.definition.title }} · {{ view.material.definition.id }}@{{ view.material.definition.version }}</p>
            <p>定义摘要：{{ view.material.entry.claim.definitionDigest }}</p>
            <p>原数据图：{{ view.material.entry.claim.origin.mapId }}</p>
            <p>原节点：{{ view.material.entry.claim.origin.nodeId }} · 原版本 {{ view.material.entry.claim.origin.revision }}</p>
          </details>
        </details>
      </section>
      <div v-if="pending && canEdit && canControl" class="review-actions">
        <button type="button" class="primary" :disabled="busy || (review?.kind === 'result' && !approvablePreview)" @click="reviewAnswer('approve')">{{ review?.kind === 'plan' ? '批准执行计划' : '批准并发布结果' }}</button>
        <button type="button" :disabled="busy" @click="reviewAnswer('reject')">拒绝本项处理</button>
      </div>
      <p v-else-if="pending" class="muted">{{ canEdit ? '领取运行控制权后可审核。' : '等待工作区编辑者或所有者确认。' }}</p>
      <p v-if="run.paused && pending" class="muted">运行已暂停；审核后仍需点击继续才会执行后续工作。</p>
    </div>
  </section>
</template>

<style scoped>
.run-review{border-top:1px solid var(--border);background:var(--bg-panel);min-width:0}
.run-header{padding:12px 14px;border-bottom:1px solid var(--border-subtle)}
.run-header small,.muted,.stage-row p,.stage-row>span,.plan-row small{color:var(--text-muted);font-size:11px;line-height:1.7}
.run-header small{display:block;margin-top:3px}h2{font-size:14px}h3{font-size:12px}h4{font-size:12px;font-weight:600}
.run-content,.material-section,.result-section,.progress-section,.candidate-list,.port-group{display:grid;gap:10px;min-width:0}
.run-content{padding:12px 14px}.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.section-heading>span{font-size:11px;color:var(--text-muted)}
.input-row,.plan-row,.candidate-row,.frozen-row{min-width:0;padding:10px 0;border-top:1px solid var(--border-subtle)}
.input-row>strong{font-size:12px}.input-row>.reader-fields{margin-top:8px}
.stage-row{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid var(--border-subtle);font-size:12px}
.candidate-row>summary,.frozen-row>summary{cursor:pointer;font-size:12px;line-height:1.8}
.candidate-row[open],.frozen-row[open]{display:grid;gap:9px}
.selection-label{margin-left:7px;color:var(--text-muted);font-size:11px}
.body-text{font:13px/1.75 var(--content-font);white-space:pre-wrap;overflow-wrap:anywhere}
.identity-details,.projection-details,.selection-notes{font-size:11px;line-height:1.8;color:var(--text-muted);overflow-wrap:anywhere}
.identity-details>summary,.projection-details>summary,.selection-notes>summary{cursor:pointer}
.identity-details p,.reference-list p{overflow-wrap:anywhere}.reference-list{display:grid;gap:7px;font-size:11px}
.scope{display:grid;gap:6px;font-size:12px}.scope>div{display:grid;grid-template-columns:70px minmax(0,1fr);gap:8px}.scope dt{color:var(--text-muted)}.scope dd{margin:0;overflow-wrap:anywhere}
.warning{font-size:12px;line-height:1.7;color:var(--danger)}.failed{color:var(--danger)}.run-status{font-size:12px}
.review-actions{display:grid;gap:7px}.review-actions button{min-height:32px}.text-action{justify-self:start;font-size:12px}
.reuse-note,.execution-spec{min-width:0;font-size:11px;line-height:1.8;overflow-wrap:anywhere;color:var(--text-muted)}
.reuse-note{display:grid;gap:8px;border-left:2px solid var(--border);padding-left:10px}.reuse-note button{justify-self:start;font-size:12px}
.execution-spec>summary,.execution-spec details>summary{cursor:pointer}.execution-spec p,.execution-spec details{margin-top:8px}.execution-spec pre{max-height:400px;overflow:auto;padding:10px;background:var(--bg-viewport);white-space:pre-wrap;overflow-wrap:anywhere}
</style>
