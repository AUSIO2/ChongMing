// 单份步骤草稿构造真实Run计划；不获取分支、控制权或预执行未来产物。
import type { CommandInputMap } from '../../../../contracts/client'
import type { DefinitionCatalog, DefinitionRef, TransitionDefinition, TransitionInputPort } from '../../../../contracts/data-definition'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphRunStep } from '../../../../contracts/graph-run'
import { evidenceBindClaimsToStep } from '../evidence-library/evidence-selection'

export type RunStartInput = Pick<CommandInputMap['run.start'], 'scope' | 'plan' | 'mode' | 'regenerate'>
export type RunStepDraft = Omit<GraphRunStep, 'transitionRef'> & { transitionRef: DefinitionRef | null }
export interface RunDraft { steps: RunStepDraft[]; mode: RunStartInput['mode']; regenerate: boolean }
export interface RunDraftSeed { transitionRef?: DefinitionRef | null; nodeIds?: readonly string[] }
interface RunDraftContext { snapshot: GraphSnapshot | null; catalog: DefinitionCatalog | null }
type RunDraftChange = { ok: true; draft: RunDraft } | { ok: false; message: string }

enum RunDraftMessage {
  CURRENT_GRAPH_REQUIRED = '请选择当前图及已发布的精确转换。',
  STEP_COUNT = '运行计划需要 1–64 个步骤。',
  STEP_ID = '步骤身份不能为空或重复。',
  TRANSITION = '所选精确转换已不可用，请重新选择。',
  DEPENDENCY = '依赖步骤不存在、重复或指向自身。',
  CYCLE = '步骤依赖存在环，请先解除循环。',
  PORTS = '所有声明的输入和上下文端口都需要一份明确绑定。',
  INPUT_CHANGED = '所选节点不存在、重复或精确类型版本不匹配。',
  OUTPUT_SOURCE = '前步来源必须是直接依赖中类型版本匹配的正式输出端口。',
  COUNT = '端口 {0} 需要 {1}–{2} 项，当前已选 {3} 项。',
  EACH = '逐个分组仅支持一个输入端口，且该端口每组必须能容纳 1 项。',
  EXPLICIT = '显式分组只支持本图输入来源，需要不重复的非空组身份及各输入端口的实际成员。',
  MATERIALS = '每个步骤最多选择 32 条固定库材料。',
  REFERENCED_STEP = '该步骤仍被其它步骤引用或依赖，请先明确解除引用。',
  REFERENCED_DEPENDENCY = '端口仍引用该直接依赖的输出，请先更换端口来源。',
  STEP_MISSING = '要修改的步骤已不存在。',
}

export function runCreateDraft(
  /* 入口只提供初始选择，不继承其它目标的模式或材料。 */ seed: RunDraftSeed = {},
  /* 当前真实作用域的精确目录，缺失时保留未解析ref。 */ catalog: DefinitionCatalog | null = null,
  /* 保存节点用于确定首个匹配input，不读取正文草稿。 */ snapshot: GraphSnapshot | null = null,
): RunDraft {
  // 每次新开保持人工审核和不重新生成，仅建立一个稳定身份的步骤。
  const reference = seed.transitionRef
  const transition = reference ? catalog?.transitions.find((/* 当前目录转换。 */ item) =>
    /* 不回落同名其它版本或第一个转换。 */ item.id === reference.id && item.version === reference.version) : null
  const step = runCreateStep(transition ?? null, { nodeIds: seed.nodeIds, snapshot })
  if (!transition && reference) step.transitionRef = { ...reference }
  return { steps: [step], mode: 'human-in-loop', regenerate: false }
}

export function runCreateStep(
  /* 用户明确选择的真实转换；未选时保留空步骤。 */ transition: TransitionDefinition | null,
  /* 入口提供的节点选择和其所属保存快照。 */ options: { nodeIds?: readonly string[]; snapshot?: GraphSnapshot | null } = {},
): RunStepDraft {
  // 全部端口显式建立空scope，seed只放首个能匹配的input，不复制到同类型其它端口。
  const nodeIds = [...(options.nodeIds ?? [])]
  const target = transition?.ports.input.find((/* 声明的一项输入端口。 */ port) =>
    /* 无快照时首input保留种子，提交前仍统一核对真实类型。 */ !options.snapshot || nodeIds.every((/* 原明确起点。 */ id) => {
      // 复杂转换从真正匹配的端口播种，缺失节点仍由提交校验提示。
      const node = options.snapshot?.nodes.find((/* 同图保存节点。 */ item) => /* 原身份精确定位。 */ item.id === id)
      return node?.typeId === port.inputType.id && node.typeVersion === port.inputType.version
    })) ?? transition?.ports.input[0]
  const input = transition?.ports.input ?? []
  const each = input.length === 1 && input[0].count.min <= 1 && input[0].count.max >= 1
  return { id: `step-${crypto.randomUUID()}`, transitionRef: transition ? { id: transition.id, version: transition.version } : null,
    dependsOn: [], input: input.map((/* 一个声明input。 */ port) => /* 每端口只持有一种来源。 */ ({ port: port.name,
      source: { kind: 'scope', nodeIds: port.name === target?.name ? [...nodeIds] : [] } })),
    context: (transition?.ports.context ?? []).map((/* 一个声明context。 */ port) => /* 不默认把input节点当上下文。 */ ({ port: port.name, source: { kind: 'scope', nodeIds: [] } })),
    grouping: { mode: each ? 'each' : 'all' }, onEmpty: 'fail' }
}

export function runAddStep(
  /* 当前独立步骤草稿。 */ draft: RunDraft,
  /* 用户选定的新步骤转换，缺省先建立空卡。 */ transition: TransitionDefinition | null = null,
): RunDraft {
  // 添加稳定ID，不重编号原卡，也不共享原输入或材料数组。
  const next = copyDraft(draft)
  next.steps.push(runCreateStep(transition))
  return next
}

export function runRemoveStep(
  /* 本次编辑的步骤草稿。 */ draft: RunDraft,
  /* 用户明确删除的稳定步骤身份。 */ stepId: string,
): RunDraftChange {
  // 被引用时拒绝删除，不级联清空其它用户配置。
  if (!draft.steps.some((/* 当前一张步骤卡。 */ step) => /* 确认原卡仍存在。 */ step.id === stepId)) return { ok: false, message: RunDraftMessage.STEP_MISSING }
  if (draft.steps.some((/* 潜在引用者。 */ step) => /* 依赖和端口来源都须先显式解除。 */ step.id !== stepId
    && (step.dependsOn.includes(stepId) || [...step.input, ...step.context].some((/* 一项端口绑定。 */ binding) =>
      /* 不把普通同图节点身份误当步骤。 */ binding.source.kind === 'step' && binding.source.stepId === stepId)))) return { ok: false, message: RunDraftMessage.REFERENCED_STEP }
  return { ok: true, draft: { ...copyDraft(draft), steps: draft.steps.filter((/* 原步骤卡。 */ step) =>
    /* 只移除指定卡。 */ step.id !== stepId).map(copyStep) } }
}

export function runBindPort(
  /* 当前独立草稿。 */ draft: RunDraft,
  /* 明确替换的一个端口及单一来源。 */ input: { stepId: string; kind: 'input' | 'context'; port: string; source: GraphRunStep['input'][number]['source'] },
): RunDraft {
  // 只替换完整来源，前步产物选择同时明确加入直接依赖，不修改原草稿。
  const next = copyDraft(draft), step = next.steps.find((/* 当前步骤。 */ item) => /* 只修改指定身份。 */ item.id === input.stepId)
  const binding = step?.[input.kind].find((/* 当前声明端口。 */ item) => /* 不合并同名多来源。 */ item.port === input.port)
  if (!step || !binding) return next
  binding.source = copySource(input.source)
  if (input.source.kind === 'step' && !step.dependsOn.includes(input.source.stepId)) step.dependsOn.push(input.source.stepId)
  return next
}

export function runSetDependencies(
  /* 当前步骤草稿。 */ draft: RunDraft,
  /* 要改变直接依赖的稳定步骤身份。 */ stepId: string,
  /* 用户明确保留的直接依赖列表。 */ dependencies: readonly string[],
): RunDraftChange {
  // 仍被端口引用的依赖不能取消，其它DAG约束在统一草稿校验中说明。
  const next = copyDraft(draft), step = next.steps.find((/* 当前步骤。 */ item) => /* 按稳定身份定位。 */ item.id === stepId)
  if (!step) return { ok: false, message: RunDraftMessage.STEP_MISSING }
  if ([...step.input, ...step.context].some((/* 保存的端口来源。 */ binding) =>
    /* 前步来源必须仍被列为直接依赖。 */ binding.source.kind === 'step' && !dependencies.includes(binding.source.stepId))) return { ok: false, message: RunDraftMessage.REFERENCED_DEPENDENCY }
  step.dependsOn = [...dependencies]
  return { ok: true, draft: next }
}

export function runReadScopeNodeIds(
  /* 所有步骤当前明确选择的真实端口来源。 */ draft: RunDraft,
): string[] {
  // 运行范围只汇总同图input/context节点，不含未来产物或库来源节点。
  return [...new Set(draft.steps.flatMap((/* 当前步骤。 */ step) => /* 同步汇总input和context。 */ [...step.input, ...step.context]
    .flatMap((/* 一项完整来源。 */ binding) => /* step来源尚无正式节点ID。 */ binding.source.kind === 'scope' ? binding.source.nodeIds : [])))]
}

export function runValidateDraft(
  /* 用户当前完整步骤配置。 */ draft: RunDraft,
  /* 当前真实图与精确目录，不持有任何执行控制。 */ context: RunDraftContext,
): string[] {
  // 只检查可静态证明的引用、类型和分组，未来正式产物数量留后端实例化核对。
  if (!context.snapshot || !context.catalog) return [RunDraftMessage.CURRENT_GRAPH_REQUIRED]
  if (!draft.steps.length || draft.steps.length > 64) return [RunDraftMessage.STEP_COUNT]
  const errors: string[] = [], byId = new Map(draft.steps.map((/* 当前稳定步骤。 */ step) => /* 建立本次有限计划索引。 */ [step.id, step]))
  if (byId.size !== draft.steps.length || draft.steps.some((/* 当前步骤。 */ step) => /* 保存身份不能为空。 */ !step.id.trim())) errors.push(RunDraftMessage.STEP_ID)
  const { snapshot, catalog } = context
  for (const step of draft.steps) {
    if (new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some((/* 一份直接依赖身份。 */ id) =>
      /* 缺失和自引用都不能形成有效计划。 */ !byId.has(id) || id === step.id)) errors.push(`${step.id}：${RunDraftMessage.DEPENDENCY}`)
    const transition = readTransition(step, catalog)
    if (!transition) { errors.push(`${step.id}：${RunDraftMessage.TRANSITION}`); continue }
    for (const kind of ['input', 'context'] as const) {
      const bindings = step[kind], ports = transition.ports[kind]
      if (bindings.length !== ports.length || new Set(bindings.map((/* 一项端口绑定。 */ binding) => /* 同端口只绑定一次。 */ binding.port)).size !== bindings.length
        || ports.some((/* 声明端口。 */ port) => /* 可选端口也需要明确空绑定。 */ !bindings.some((/* 保存绑定。 */ binding) => /* 精确端口名。 */ binding.port === port.name))) {
        errors.push(`${step.id}：${RunDraftMessage.PORTS}`); continue
      }
      for (const binding of bindings) {
        const port = ports.find((/* 声明端口。 */ item) => /* 读取已确认存在的端口合同。 */ item.name === binding.port)
        if (!port) continue
        if (binding.source.kind === 'scope') {
          const nodeIds = binding.source.nodeIds
          if (new Set(nodeIds).size !== nodeIds.length || nodeIds.some((/* 明确同图节点。 */ id) => {
            // 每端口分别核对实际节点与精确类型，不能借另一端口的同名正文。
            const node = snapshot.nodes.find((/* 当前保存图中的节点。 */ item) => /* 按真实ID定位。 */ item.id === id)
            return !node || node.typeId !== port.inputType.id || node.typeVersion !== port.inputType.version
          })) errors.push(`${step.id}.${port.name}：${RunDraftMessage.INPUT_CHANGED}`)
          if (kind === 'context' || step.grouping.mode === 'all') checkCount(nodeIds.length, port, step.id, errors)
          else if (step.grouping.mode === 'each' && !nodeIds.length) checkCount(0, port, step.id, errors)
        } else {
          const source = byId.get(binding.source.stepId), outputName = binding.source.port
          const output = source ? readTransition(source, catalog)?.ports.output.find((/* 上游正式输出端口。 */ item) =>
            /* 不从候选或其它端口借正文。 */ item.name === outputName) : undefined
          if (!source || !step.dependsOn.includes(source.id) || !output || output.outputType.id !== port.inputType.id || output.outputType.version !== port.inputType.version) {
            errors.push(`${step.id}.${port.name}：${RunDraftMessage.OUTPUT_SOURCE}`)
          }
        }
      }
    }
    if (step.grouping.mode === 'each' && (transition.ports.input.length !== 1 || transition.ports.input[0].count.min > 1 || transition.ports.input[0].count.max < 1)) {
      errors.push(`${step.id}：${RunDraftMessage.EACH}`)
    }
    if (step.grouping.mode === 'explicit') validateExplicit(step, transition, errors)
    if ((step.libraryClaimRefs?.length ?? 0) > 32) errors.push(`${step.id}：${RunDraftMessage.MATERIALS}`)
  }
  if (hasCycle(byId)) errors.push(RunDraftMessage.CYCLE)
  return errors
}

export function runBuildSubmission(
  /* 一份完整且独立的运行草稿。 */ draft: RunDraft,
  /* 当前保存图和精确目录，各步材料已在其步骤内。 */ context: RunDraftContext,
): { ok: true; input: RunStartInput } | { ok: false; message: string } {
  // 一次核对全部草稿并构造普通数据副本，异步启动不再读取响应式草稿。
  const errors = runValidateDraft(draft, context)
  if (errors.length) return { ok: false, message: errors[0] }
  const steps: GraphRunStep[] = []
  for (const step of draft.steps) {
    const reference = step.transitionRef
    if (!reference) return { ok: false, message: RunDraftMessage.TRANSITION }
    const plain: GraphRunStep = { ...copyStep(step), transitionRef: { ...reference } }
    steps.push(evidenceBindClaimsToStep(plain, step.libraryClaimRefs ?? []))
  }
  return { ok: true, input: { scope: { nodeIds: runReadScopeNodeIds(draft) }, plan: { steps }, mode: draft.mode, regenerate: draft.regenerate } }
}

export function runReadSelectionKey(
  /* 所有步骤的当前目标配置，不含选材浏览状态。 */ draft: RunDraft,
  /* 当前真实图，仅绑定相关保存节点的类型和内容版本。 */ snapshot: GraphSnapshot | null,
  /* 服务是否明确提供固定证据库。 */ libraryAvailable: boolean,
  /* 当前步骤稳定身份，材料失效只影响它和实际依赖后代。 */ stepId: string,
): string {
  // 先收上游ID集合再稳定编码，菱形DAG不会重复递归展开，也不把材料写回key。
  const byId = new Map(draft.steps.map((/* 当前稳定步骤。 */ step) => /* 查询本步与依赖目标。 */ [step.id, step]))
  const related = new Set<string>(), pending = [stepId]
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]
    if (related.has(id)) continue
    related.add(id)
    const step = byId.get(id)
    if (step) pending.push(...step.dependsOn, ...[...step.input, ...step.context].flatMap((/* 当前来源。 */ binding) =>
      /* 未完成的配置也明确包含其上游身份。 */ binding.source.kind === 'step' ? [binding.source.stepId] : []))
  }
  const targets = [...related].sort().map((/* 唯一上游身份。 */ id) => {
    // 只序列化目标规则，排除所有libraryClaimRefs及全局mode/regenerate。
    const step = byId.get(id)
    if (!step) return { id, missing: true }
    const bindings = (/* 本步的一类端口绑定。 */ values: GraphRunStep['input']) =>
      /* 端口和scope成员用稳定顺序表达相同目标集合。 */ [...values].sort((/* 前一端口。 */ left, /* 后一端口。 */ right) => /* 不修改原绑定数组。 */ left.port.localeCompare(right.port))
        .map((/* 当前端口来源。 */ binding) => /* 只复制目标身份。 */ ({ port: binding.port, source: binding.source.kind === 'scope'
          ? { kind: 'scope', nodeIds: [...binding.source.nodeIds].sort() } : { ...binding.source } }))
    return { id, transitionRef: step.transitionRef, dependsOn: [...step.dependsOn].sort(), input: bindings(step.input), context: bindings(step.context),
      grouping: step.grouping, onEmpty: step.onEmpty }
  })
  const nodeIds = new Set([...related].flatMap((/* 唯一相关步骤。 */ id) => {
    // 相关节点只来自该步同图scope，不掺入未来产物或选材来源。
    const step = byId.get(id)
    return step ? [...step.input, ...step.context].flatMap((/* 一项端口来源。 */ binding) =>
      /* step来源没有预先分配的节点ID。 */ binding.source.kind === 'scope' ? binding.source.nodeIds : []) : []
  }))
  const nodes = [...nodeIds].sort().map((/* 相关保存节点身份。 */ id) => {
    // 正文版本变化只使真正相关步骤的材料失效，无关整图同步不进入key。
    const node = snapshot?.nodes.find((/* 当前保存节点。 */ item) => /* 按身份读取当前版本。 */ item.id === id)
    return node ? [id, node.typeId, node.typeVersion, node.revision] : [id, null]
  })
  return JSON.stringify([snapshot?.mapId ?? null, libraryAvailable, targets, nodes])
}

function copyDraft(
  /* 当前可能为Vue代理的编辑草稿。 */ draft: RunDraft,
): RunDraft {
  // 复制DTO每个可变集合，避免structuredClone响应式代理失败。
  return { steps: draft.steps.map(copyStep), mode: draft.mode, regenerate: draft.regenerate }
}
function copyStep(
  /* 当前可能为Vue代理的一张步骤卡。 */ step: RunStepDraft,
): RunStepDraft {
  // 分组成员、来源、依赖与每步材料分别复制，不共享可写数组。
  const grouping = step.grouping.mode === 'explicit' ? { mode: 'explicit' as const, groups: step.grouping.groups.map((/* 保存的一份显式组。 */ group) =>
    /* 每端口成员数组单独复制。 */ ({ id: group.id, members: Object.fromEntries(Object.entries(group.members).map((/* 当前端口与成员。 */ [port, members]) =>
      /* 不把context额外塞进members。 */ [port, [...members]])) })) } : { ...step.grouping }
  return { id: step.id, transitionRef: step.transitionRef ? { ...step.transitionRef } : null, dependsOn: [...step.dependsOn],
    input: step.input.map((/* 声明的input。 */ binding) => /* 复制唯一来源。 */ ({ port: binding.port, source: copySource(binding.source) })),
    context: step.context.map((/* 声明的context。 */ binding) => /* 只读上下文也保留明确来源。 */ ({ port: binding.port, source: copySource(binding.source) })),
    grouping, onEmpty: step.onEmpty, ...(step.libraryClaimRefs ? { libraryClaimRefs: step.libraryClaimRefs.map((/* 固定材料精确身份。 */ ref) => /* 分步骤复制。 */ ({ ...ref })) } : {}) }
}
function copySource(
  /* 一端口的一种真实来源。 */ source: GraphRunStep['input'][number]['source'],
): GraphRunStep['input'][number]['source'] {
  // scope节点和step端口引用保持真实判别类型，不混成可选字段集合。
  return source.kind === 'scope' ? { kind: 'scope', nodeIds: [...source.nodeIds] } : { ...source }
}
function readTransition(
  /* 保存精确引用的当前步骤。 */ step: RunStepDraft,
  /* 当前真实作用域目录。 */ catalog: DefinitionCatalog,
): TransitionDefinition | undefined {
  // 按精确身份读取，不使用latest或跨范围定义。
  return catalog.transitions.find((/* 一份已发布转换。 */ item) => /* 版本与身份同时相符。 */ item.id === step.transitionRef?.id && item.version === step.transitionRef.version)
}
function checkCount(
  /* 当前已知的单组节点数量。 */ count: number,
  /* 声明该组数量的端口。 */ port: TransitionInputPort,
  /* 当前步骤稳定身份。 */ stepId: string,
  /* 本次校验独占的错误列表。 */ errors: string[],
): void {
  // 仅对静态已知数量追加提示，不估算动态上游总量。
  if (count < port.count.min || count > port.count.max) errors.push(`${stepId}：${RunDraftMessage.COUNT.replace('{0}', port.name)
    .replace('{1}', String(port.count.min)).replace('{2}', String(port.count.max)).replace('{3}', String(count))}`)
}
function validateExplicit(
  /* 当前保存显式成员表的步骤。 */ step: RunStepDraft,
  /* 精确转换的真实端口定义。 */ transition: TransitionDefinition,
  /* 本次校验独占的错误列表。 */ errors: string[],
): void {
  // 首版显式组只解析input scope实际成员，context独立共享且不参与成员表。
  if (step.grouping.mode !== 'explicit') return
  const groups = step.grouping.groups
  if (step.input.some((/* 一项input来源。 */ binding) => /* 不预填未来节点。 */ binding.source.kind !== 'scope') || !groups.length
    || new Set(groups.map((/* 一份用户组。 */ group) => /* 每组有稳定身份。 */ group.id)).size !== groups.length) errors.push(`${step.id}：${RunDraftMessage.EXPLICIT}`)
  for (const group of groups) {
    if (!group.id.trim() || Object.keys(group.members).some((/* 显式成员表的端口名。 */ name) =>
      /* context或未知端口不允许混入input成员表。 */ !transition.ports.input.some((/* 声明input。 */ port) => /* 同名端口匹配。 */ port.name === name))) errors.push(`${step.id}：${RunDraftMessage.EXPLICIT}`)
    for (const port of transition.ports.input) {
      const members = Object.prototype.hasOwnProperty.call(group.members, port.name) ? group.members[port.name] : []
      const binding = step.input.find((/* 实际端口来源。 */ item) => /* 每端口只认自己的候选成员。 */ item.port === port.name)
      if (!binding || binding.source.kind !== 'scope') continue
      const available = binding.source.nodeIds
      if (new Set(members).size !== members.length || members.some((/* 一项明确组成员。 */ id) => /* 不能借别的端口节点。 */ !available.includes(id))) errors.push(`${step.id}：${RunDraftMessage.EXPLICIT}`)
      checkCount(members.length, port, `${step.id}.${group.id}`, errors)
    }
  }
}
function hasCycle(
  /* 本次有限步骤计划的稳定身份索引。 */ byId: Map<string, RunStepDraft>,
): boolean {
  // 检查依赖环，缺失依赖已在主校验单独提示，不在此猜测默认步骤。
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (/* 当前要检查的步骤。 */ id: string): boolean => {
    // 同一路径再次进入即为环，已完整检查的分支不重复展开。
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    const step = byId.get(id)
    if (!step) return false
    visiting.add(id)
    if (step.dependsOn.some(visit)) return true
    visiting.delete(id); visited.add(id)
    return false
  }
  return [...byId.keys()].some(visit)
}
