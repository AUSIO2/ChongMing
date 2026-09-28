// 在图草稿中推进节点运行、产物和人工审核；持久化与租约仲裁由图服务负责。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import type { GraphDataActor, GraphDataProposal, GraphDataRead, GraphNode, GraphOperation, GraphRouteSlot, GraphRun, GraphRunConfiguration, GraphCommand } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import { storeCreateInputHash, type GraphDocument } from './graph-record'

function runReadRun(/* 包含待读取当前 Run 的图草稿。 */ document: GraphDocument): GraphRun {
  // 读取图的当前 Run，并拒绝尚未迁移的旧版单操作结构。
  if (!document.run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.MAP_HAS_NO_RUN)
  if (!Array.isArray(document.run.operations)) throw new GraphError(409, 'RUN_SCHEMA_UNSUPPORTED', RuntimeMessage.USE_THE_EXPLICIT_NODE_RUN_MIGRATION)
  return document.run
}
function runReadExecution(/* 包含待验证活动状态 Run 的图草稿。 */ document: GraphDocument): GraphRun {
  // 要求当前 Run 仍在运行或等待审核，阻止继续修改终态运行。
  const run = runReadRun(document)
  if (!['running', 'waiting'].includes(run.status)) throw new GraphError(409, 'RUN_NOT_ACTIVE', RuntimeMessage.RUN_IS_TERMINAL)
  return run
}
export function runReadOperation(/* 包含待查 Operation 的当前或历史 Run。 */ run: GraphRun, /* 需要在该 Run 内唯一定位的 Operation 身份。 */ id: string): GraphOperation {
  // 按 Operation 身份读取当前 Run 内的操作，不接受其他运行的操作。
  const operation = run.operations.find(/* 当前与目标 Operation 身份比较的操作。 */ item => /* 定位这次调用指定的 Operation。 */ item.id === id)
  if (!operation) throw new GraphError(404, 'OPERATION_NOT_FOUND', RuntimeMessage.UNKNOWN_OPERATION)
  return operation
}
function runValidateInputs(/* 包含当前节点版本、用于验证冻结输入的图草稿。 */ document: GraphDocument, /* 其 inputRefs 必须仍与图节点匹配的 Operation。 */ operation: GraphOperation): void {
  // 核对操作冻结的每个输入节点及版本，拒绝基于已修改或删除输入继续执行。
  for (const ref of operation.inputRefs) if (!document.nodes.some(/* 当前与冻结输入身份和版本比较的图节点。 */ node => /* 寻找身份与冻结版本均匹配的输入节点。 */ node.id === ref.id && node.revision === ref.revision)) {
    throw new GraphError(409, 'INPUT_STALE', messageFormat(RuntimeMessage.OPERATION_INPUT_CHANGED_VALUE, ref.id))
  }
}
function runReadConfiguration(/* 保存启动时冻结执行配置的 Run。 */ run: GraphRun, /* 需要选择解析、拆分或核查配置的 Operation 类型。 */ kind: GraphOperation['kind']) {
  // 按解析、拆分或核查阶段选择本 Run 的配置，并明确报告缺失能力。
  if (kind === 'parse') {
    if (!run.configuration.parse) throw new GraphError(422, 'CONFIGURATION_REQUIRED', RuntimeMessage.SOURCE_PARSING_REQUIRES_A_PARSE_AGENT)
    return run.configuration.parse
  }
  if (kind === 'split') {
    if (!run.configuration.split) throw new GraphError(422, 'CONFIGURATION_REQUIRED', RuntimeMessage.NEWS_SPLITTING_REQUIRES_ROUTE_WORKER_AND_MERGE_AGENTS)
    return { ...run.configuration.split, tools: run.configuration.tools, maxSlots: run.configuration.maxSlots }
  }
  const { router, merger, agents, tools, maxSlots } = run.configuration
  return { router, merger, agents, tools, maxSlots }
}
function runValidateSlots(/* 提供冻结配置和最大槽位数的当前 Run。 */ run: GraphRun, /* 决定使用拆分或核查 Agent 组的 Operation。 */ operation: GraphOperation, /* 路由提案提交、尚待核对 Agent 和工具能力的槽位。 */ slots: GraphRouteSlot[]): GraphRouteSlot[] {
  // 校验路由槽位数量和唯一身份，确认 Agent 存在且工具未超出该 Agent 能力，返回独立副本。
  const configuration = operation.kind === 'split' ? run.configuration.split! : run.configuration
  if (!slots.length || slots.length > run.configuration.maxSlots || new Set(slots.map(/* 当前提取身份以检查重复槽位的路由项。 */ slot => /* 提取槽位身份以检查同一路由中的重复槽位。 */ slot.id)).size !== slots.length) {
    throw new GraphError(422, 'INVALID_ROUTE', RuntimeMessage.ROUTE_MUST_CONTAIN_UNIQUE_SLOTS_WITHIN_MAXSLOTS)
  }
  for (const slot of slots) {
    const agent = configuration.agents.find(/* 当前与槽位绑定身份比较的冻结 Agent。 */ agent => /* 在当前阶段配置中查找槽位绑定的 Agent。 */ agent.id === slot.agentId)
    if (!agent) throw new GraphError(422, 'UNKNOWN_AGENT', messageFormat(RuntimeMessage.UNKNOWN_ROUTE_AGENT_VALUE, slot.agentId))
    if (new Set(slot.tools).size !== slot.tools.length || slot.tools.some(/* 当前检查是否超出该 Agent 能力的槽位工具。 */ tool => /* 找出该槽位请求但 Agent 未开放的工具。 */ !agent.tools.includes(tool))) {
      throw new GraphError(422, 'TOOL_NOT_ALLOWED', messageFormat(RuntimeMessage.TOOLS_EXCEED_CAPABILITIES_OF_VALUE, agent.id))
    }
  }
  return structuredClone(slots)
}
function runCreateReview(/* 需要转入等待并挂载审核记录的 Operation。 */ operation: GraphOperation, /* 审核路由还是最终结果的业务类型。 */ kind: 'route' | 'result', /* 写入新审核记录 createdAt 的 ISO 时间；Operation 本身没有更新时间字段。 */ now: string): void {
  // 将操作改为等待状态，并建立具有独立身份和版本的待处理审核。
  operation.status = 'waiting'
  operation.review = { id: randomUUID(), kind, revision: 0, state: 'pending', decision: null, createdAt: now, answeredAt: null }
}
function runReadPhase(/* 需要投影为 parse、route、workers、merge、waiting 或 done 阶段的 Operation。 */ operation: GraphOperation): GraphDataRead['phase'] {
  // 依据操作状态、路由批准情况和报告覆盖情况计算当前可执行阶段。
  if (!['running', 'waiting'].includes(operation.status)) return 'done'
  if (operation.status === 'waiting') return 'waiting'
  if (operation.kind === 'parse') return 'parse'
  if (!operation.route) return 'route'
  if (!operation.route.approved) return 'waiting'
  const reports = operation.kind === 'split' ? operation.splitReports : operation.reports
  return operation.route.slots.every(/* 当前检查是否已有对应报告的批准槽位。 */ slot => /* 检查当前路由的每个槽位是否都已有报告。 */ reports.some(/* 当前与槽位身份比较的已接纳报告。 */ report => /* 按槽位身份确认该槽位报告已被接纳。 */ report.slotId === slot.id)) ? 'merge' : 'workers'
}
function runReadProposalId(/* 需要根据执行角色生成提案身份的 Operation。 */ operation: GraphOperation, /* 当前领取工作的解析、路由、Worker 或汇总角色。 */ actor: GraphDataActor): string {
  // 根据操作、角色、路由版本及槽位生成稳定提案身份，隔离不同执行阶段。
  if (actor.role === 'parse') return operation.id + ':parse'
  if (actor.role === 'router') return operation.id + ':route'
  const version = operation.route?.revision ?? 0
  return actor.role === 'worker' ? operation.id + ':report:' + version + ':' + actor.slotId : operation.id + ':merge:' + version
}
function runCanReuse(/* 包含历史产物节点和关系现状的图草稿。 */ document: GraphDocument, /* 候选历史 Operation，需在函数内确认已完成且输入、配置与产物仍匹配。 */ operation: GraphOperation, /* 本次 Run 根据当前输入和配置建立的新 Operation。 */ next: GraphOperation): boolean {
  // 仅复用输入版本、配置和目标一致，且产物及来源关系仍有效的已完成 Operation。
  if (operation.status !== 'completed' || operation.kind !== next.kind || operation.targetId !== next.targetId
    || operation.configurationHash !== next.configurationHash
    || storeCreateInputHash(operation.inputRefs) !== storeCreateInputHash(next.inputRefs)) return false
  if (operation.kind === 'verify' && (operation.outputRefs.length !== 1 || operation.outputRefs[0].id !== operation.resultNodeId)) return false
  return operation.outputRefs.every(/* 历史 Operation 中当前检查是否仍有效的产物引用。 */ ref => {
    // 检查历史产物未被修改或标记过时，并且仍属于同一输入节点。
    if (!document.nodes.some(/* 当前与历史产物身份、版本和有效性匹配的图节点。 */ node => /* 匹配历史产物记录的节点版本及有效状态。 */ node.id === ref.id && node.revision === ref.revision && node.validity !== 'stale')) return false
    return document.edges.some(/* 当前检查历史产物是否仍连接到同一输入的关系。 */ edge => /* 核对产物仍通过预期关系指向本次目标。 */ edge.kind === (operation.kind === 'verify' ? 'verifies' : 'derived-from')
      && edge.from === ref.id && edge.to === operation.targetId)
  })
}
export function runUpdateProgress(/* 在原地建立 Operation、展开后继并汇总状态的图草稿。 */ document: GraphDocument, /* 本轮进度变化统一写入的 ISO 时间。 */ now: string): void {
  // 在传入图草稿上建立或复用 Operation，展开范围内的后继节点，并汇总 Run 状态与时间。
  const run = runReadRun(document)
  if (['cancelled', 'failed'].includes(run.status)) return
  const pending = [...run.scope.nodeIds], seen = new Set<string>()
  for (let index = 0; index < pending.length; index++) {
    const targetId = pending[index]
    if (seen.has(targetId)) continue
    seen.add(targetId)
    const target = document.nodes.find(/* 当前与待处理目标身份匹配的图节点。 */ node => /* 查找本轮待推进的目标节点。 */ node.id === targetId)
    if (!target) throw new GraphError(409, 'INPUT_STALE', messageFormat(RuntimeMessage.SCOPE_NODE_IS_MISSING_VALUE, targetId))
    const kind = target.data.kind === 'source' ? 'parse'
      : target.data.kind === 'news' && run.until !== 'news' ? 'split'
      : target.data.kind === 'claim' && run.until === 'verified' ? 'verify' : null
    if (!kind) continue
    let operation = run.operations.find(/* 当前与目标和阶段匹配、避免重复创建的本 Run Operation。 */ item => /* 同一目标和阶段在当前 Run 中只建立一个 Operation。 */ item.kind === kind && item.targetId === targetId)
    if (!operation) {
      const inputIds = new Set([targetId, ...(kind === 'verify'
        ? document.edges
          .filter(/* 核查阶段当前检查是否从关联新闻冻结输入的关系。 */ edge => /* 核查事实时同时冻结提及该事实的新闻输入。 */ edge.kind === 'mentions' && edge.to === targetId)
          .map(/* 符合 mentions 关系后当前提取来源新闻身份的关系。 */ edge => /* 提取关联新闻的节点身份。 */ edge.from) : [])])
      operation = {
        id: run.id + ':' + kind + ':' + targetId, kind, targetId, status: 'running',
        inputRefs: document.nodes
          .filter(/* 当前判断是否属于本 Operation 输入集合的图节点。 */ node => /* 只记录本 Operation 依赖的输入节点。 */ inputIds.has(node.id))
          .map(/* 当前转换为冻结身份和版本引用的输入节点。 */ node => /* 冻结节点身份与版本以检测后续输入变更。 */ ({ id: node.id, revision: node.revision }))
          .sort((/* 比较冻结输入引用稳定顺序时位于左侧的项。 */ a, /* 比较冻结输入引用稳定顺序时位于右侧的项。 */ b) => /* 固定输入顺序，使历史复用时的哈希可比较。 */ a.id.localeCompare(b.id)),
        configurationHash: storeCreateInputHash(runReadConfiguration(run, kind)), outputRefs: [],
        route: null, reports: [], splitReports: [], draft: null, contentDraft: null, review: null, resultNodeId: null,
      }
      if (!run.regenerate) {
        // 仅在未要求重新生成时，从最近的历史 Operation 中寻找仍可复用的完整结果。
        const prior = document.runHistory
          .flatMap(/* 当前展开其 Operation 以搜索历史可复用结果的 Run。 */ item => /* 按历史 Run 顺序收集其 Operation。 */ item.operations).reverse()
          .find(/* 当前与新 Operation 输入、配置和目标比较的历史操作。 */ item => /* 选出输入、配置和产物均仍匹配的最近结果。 */ runCanReuse(document, item, operation!))
        if (prior) operation = { ...structuredClone(prior), id: operation.id }
      }
      run.operations.push(operation)
    }
    if (operation.status === 'completed') pending.push(...operation.outputRefs.map(/* 已完成 Operation 中当前加入后继处理队列的产物引用。 */ ref => /* 将本次已完成产物加入后继处理队列。 */ ref.id))
    // 范围只沿来源→新闻→事实展开，不从共享事实反向扩到其他新闻。
    // 显式关系展开时排除已知历史产物；历史复用的产物由上面的 completed 分支加入队列。
    const historicalOutputs = new Set(document.runHistory
      .flatMap(/* 当前展开其 Operation 以收集旧产物身份的历史 Run。 */ history => /* 收集过去 Run 的 Operation 以识别旧产物。 */ history.operations)
      .filter(/* 当前判断是否由同一目标和阶段生成的历史 Operation。 */ item => /* 只追踪同一目标和阶段生成过的产物。 */ item.targetId === targetId && item.kind === kind)
      .flatMap(/* 当前展开产物引用的历史 Operation。 */ item => /* 展开该阶段的历史产物身份。 */ item.outputRefs
        .map(/* 当前提取节点身份的历史产物引用。 */ ref => /* 提取用于排除重复历史分支的节点身份。 */ ref.id)))
    if (kind === 'parse') pending.push(...document.edges
      .filter(/* 解析阶段当前查找明确派生新闻的关系。 */ edge => /* 查找明确派生自当前来源的新闻关系。 */ edge.kind === 'derived-from' && edge.to === targetId)
      .map(/* 当前转换为派生新闻身份的关系。 */ edge => /* 取得派生新闻的节点身份。 */ edge.from)
      .filter(/* 当前判断是否需要排除历史产物的派生节点身份。 */ id => /* 将不属于历史产物的现有新闻加入范围。 */ !historicalOutputs.has(id)
        && document.nodes.some(/* 当前确认派生身份仍指向现存新闻的图节点。 */ node => /* 确认关系指向现存新闻。 */ node.id === id && node.data.kind === 'news')))
    if (kind === 'split') pending.push(...document.edges
      .filter(/* 拆分阶段当前查找新闻明确提及事实的关系。 */ edge => /* 查找当前新闻明确提及的事实。 */ edge.kind === 'mentions' && edge.from === targetId)
      .map(/* 当前转换为被提及事实身份的关系。 */ edge => /* 取得该新闻提及的事实身份。 */ edge.to)
      .filter(/* 当前判断是否需要排除历史产物的事实身份。 */ id => /* 避免通过旧拆分产物重新展开历史分支。 */ !historicalOutputs.has(id)))
  }
  // 任一失败优先终止 Run；仍有可执行 Operation 时，即使其他 Operation 等待审核也保持运行。
  run.status = run.operations.some(/* 当前检查失败优先级的 Operation。 */ operation => /* 检查是否有失败阶段需要终止整个 Run。 */ operation.status === 'failed') ? 'failed'
    : run.operations.some(/* 当前检查是否仍可执行的 Operation。 */ operation => /* 判断是否仍有阶段可以继续执行。 */ operation.status === 'running') ? 'running'
    : run.operations.some(/* 当前检查是否仍在等待审核的 Operation。 */ operation => /* 所有可执行阶段结束后，判断是否还需等待审核。 */ operation.status === 'waiting') ? 'waiting' : 'completed'
  run.updatedAt = now; document.updatedAt = now
}
function runCreateOutputs(/* 接收产物并写入节点与关系的图草稿。 */ document: GraphDocument, /* 包含已批准草稿、准备完成的 Operation。 */ operation: GraphOperation, /* 所有新产物和关系共同使用的 ISO 创建时间。 */ now: string) {
  // 把已批准的解析、拆分或核查草稿写入图草稿，记录产物与关系并完成操作。
  const nodeIds: string[] = [], edgeIds: string[] = []
  function runCreateOutput(/* 需要发布为新图节点的解析、拆分或核查数据。 */ data: GraphNode['data'], /* 拆分产物对应的可选报告身份。 */ reportId?: string, /* 拆分产物在原报告候选数组中的可选零基位置。 */ index?: number) {
    // 创建一个产物及其来源关系，登记产物引用；拆分事实同时建立新闻引用边。
    const id = randomUUID()
    document.nodes.push({ id, revision: 0, data, createdAt: now, updatedAt: now })
    operation.outputRefs.push({ id, revision: 0, ...(reportId === undefined ? {} : { reportId, index }) })
    nodeIds.push(id)
    const edgeId = randomUUID()
    document.edges.push({ id: edgeId, revision: 0, kind: operation.kind === 'verify' ? 'verifies' : 'derived-from',
      from: id, to: operation.targetId, createdAt: now, updatedAt: now })
    edgeIds.push(edgeId)
    if (operation.kind === 'split') {
      const mentionId = randomUUID()
      document.edges.push({ id: mentionId, revision: 0, kind: 'mentions', from: operation.targetId, to: id, createdAt: now, updatedAt: now })
      edgeIds.push(mentionId)
    }
    return id
  }
  if (operation.kind === 'verify') {
    if (!operation.draft) throw new GraphError(409, 'MERGE_REQUIRED', RuntimeMessage.NO_ACCEPTED_MERGE_DRAFT)
    operation.resultNodeId = runCreateOutput({ kind: 'verification', score: operation.draft.score, reason: operation.draft.reason,
      reportIds: operation.draft.reportIds, opinions: structuredClone(operation.reports) })
  } else if (operation.contentDraft?.kind === 'parse') {
    for (const news of operation.contentDraft.news) runCreateOutput({ kind: 'news', ...structuredClone(news) })
  } else if (operation.contentDraft?.kind === 'split') {
    for (const selection of operation.contentDraft.selected) {
      const report = operation.splitReports.find(/* 当前与汇总选择的报告身份匹配的拆分报告。 */ item => /* 找到被汇总选择的候选事实所在报告。 */ item.id === selection.reportId)!
      runCreateOutput({ kind: 'claim', ...structuredClone(report.claims[selection.index]) }, report.id, selection.index)
    }
  } else throw new GraphError(409, 'DRAFT_REQUIRED', RuntimeMessage.NO_ACCEPTED_NODE_DRAFT)
  operation.status = 'completed'
  return { nodeIds, edgeIds }
}
export function runCreateRun(/* 准备归档旧 Run 并建立新 Run 的图草稿。 */ document: GraphDocument, /* 经过命令边界校验的新 Run 身份、范围和模式。 */ input: Extract<GraphCommand, { method: 'run.start' }>['params'],
  /* 从工作区解析、需为本次 Run 深拷贝冻结的执行配置。 */ configuration: GraphRunConfiguration, /* 新 Run 的 ISO 创建时间，同时用于本轮 Run 和图状态的更新时间。 */ now: string): GraphDocument {
  // 校验新 Run 的范围与身份，在图草稿中归档旧 Run、保存配置副本，并建立首批 Operation。
  if (document.run) runReadRun(document)
  if (document.run && ['running', 'waiting'].includes(document.run.status)) throw new GraphError(409, 'RUN_ACTIVE', RuntimeMessage.MAP_ALREADY_HAS_AN_ACTIVE_RUN)
  if (document.run?.id === input.id || document.runHistory.some(/* 当前检查是否复用新 Run 身份的历史 Run。 */ run => /* 防止新 Run 复用历史身份而混淆工作和收据。 */ run.id === input.id)) throw new GraphError(409, 'RUN_ID_REUSED', RuntimeMessage.USE_A_NEW_RUN_ID)
  if (!input.scope.nodeIds.length || new Set(input.scope.nodeIds).size !== input.scope.nodeIds.length) throw new GraphError(422, 'INVALID_SCOPE', RuntimeMessage.CHOOSE_UNIQUE_SCOPE_NODES)
  for (const id of input.scope.nodeIds) {
    const node = document.nodes.find(/* 当前与用户选择范围身份匹配的图节点。 */ node => /* 查找用户指定的起始节点以验证运行范围。 */ node.id === id)
    if (!node || !['source', 'news', 'claim'].includes(node.data.kind)) throw new GraphError(422, 'INVALID_RUN_TARGET', RuntimeMessage.SCOPE_MUST_CONTAIN_SOURCE_NEWS_OR_CLAIM_NODES)
  }
  if (document.run) document.runHistory.push(document.run)
  // Run 持有独立配置副本，后续工作区配置修改不会改变本次执行的 Agent 与工具规则。
  document.run = { id: input.id, scope: structuredClone(input.scope), until: input.until, paused: false, regenerate: input.regenerate === true,
    mode: input.mode, status: 'running', configuration: structuredClone(configuration), operations: [], createdAt: now, updatedAt: now }
  runUpdateProgress(document, now)
  return document
}
export function runCancelRun(/* 其活动 Run 将被标记取消的图草稿。 */ document: GraphDocument, /* 目标 Run 的业务编号，必须匹配当前活动 Run，区别于命令的幂等请求编号。 */ runId: string, /* 取消状态写入 Run 和图的 ISO 时间。 */ now: string): GraphDocument {
  // 将活动 Run 及其未完成操作标记为取消并更新时间；租约可用性由存储状态检查约束。
  const run = runReadExecution(document)
  if (run.id !== runId) throw new GraphError(409, 'RUN_CONFLICT', RuntimeMessage.RUNID_IS_NOT_ACTIVE)
  run.status = 'cancelled'
  for (const operation of run.operations) if (['running', 'waiting'].includes(operation.status)) operation.status = 'cancelled'
  run.updatedAt = now; document.updatedAt = now
  return document
}
export function runUpdatePause(/* 其活动 Run 将被暂停或恢复的图草稿。 */ document: GraphDocument, /* 目标 Run 的业务编号，必须匹配当前活动 Run，区别于命令的幂等请求编号。 */ runId: string, /* 目标暂停状态；true 停止工作发现，租约撤销由后续存储提交完成，false 恢复工作发现。 */ paused: boolean, /* 暂停或恢复状态写入 Run 和图的 ISO 时间。 */ now: string): GraphDocument {
  // 校验当前 Run 和冻结输入后切换暂停标记，再汇总进度；暂停撤租由提交层完成。
  const run = runReadExecution(document)
  if (run.id !== runId) throw new GraphError(409, 'RUN_CONFLICT', RuntimeMessage.RUNID_IS_NOT_ACTIVE)
  for (const operation of run.operations) runValidateInputs(document, operation)
  run.paused = paused
  runUpdateProgress(document, now)
  return document
}
export function runUpdateReview(/* 包含待编辑路由审核的图草稿。 */ document: GraphDocument, /* 路由审核身份、版本、理由和新槽位。 */ input: Extract<GraphCommand, { method: 'review.update' }>['params'], /* 审核编辑写入 Run 和图的 ISO 时间。 */ now: string): GraphDocument {
  // 仅编辑版本匹配的待审路由，替换经校验的槽位并同时推进路由和审核版本。
  const run = runReadExecution(document), operation = runReadOperation(run, input.operationId)
  const review = operation.review, route = operation.route
  if (run.id !== input.runId || !review || review.id !== input.reviewId || review.state !== 'pending'
    || review.kind !== 'route' || review.revision !== input.expectedReviewRevision || !route || route.approved) throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.ROUTE_REVIEW_IS_NOT_EDITABLE)
  route.slots = runValidateSlots(run, operation, input.slots); route.reason = input.reason; route.revision++; review.revision++
  run.updatedAt = now; document.updatedAt = now
  return document
}
export function runAnswerReview(/* 包含待回答审核及草稿产物的图草稿。 */ document: GraphDocument, /* 审核身份、预期版本及批准或拒绝决定。 */ input: Extract<GraphCommand, { method: 'review.answer' }>['params'], /* 审核回答及可能产物使用的 ISO 时间。 */ now: string) {
  // 在审核身份、版本及输入仍匹配时记录决定，批准路由或发布产物，拒绝则使操作失败。
  const run = runReadExecution(document), operation = runReadOperation(run, input.operationId), review = operation.review
  if (run.id !== input.runId || !review || review.id !== input.reviewId || review.state !== 'pending'
    || review.revision !== input.expectedReviewRevision) throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.REVIEW_CHANGED_OR_IS_NO_LONGER_PENDING)
  runValidateInputs(document, operation)
  review.state = 'answered'; review.decision = input.decision; review.answeredAt = now; review.revision++
  let result = { nodeIds: [] as string[], edgeIds: [] as string[] }
  if (input.decision === 'reject') operation.status = 'failed'
  else if (review.kind === 'route') { operation.route!.approved = true; operation.status = 'running' }
  else result = runCreateOutputs(document, operation, now)
  runUpdateProgress(document, now)
  return { document, ...result }
}
export function runReadData(/* 包含目标、冻结输入和当前执行阶段的图状态。 */ document: GraphDocument, /* 工作授权限定的 Operation 身份。 */ operationId: string, /* 决定可见阶段、槽位和提案身份的执行角色。 */ actor: GraphDataActor): Omit<GraphDataRead, 'work'> {
  // 校验操作输入与工作槽位，生成面向执行者的目标和上下文副本，并过滤对 AI 不可见的字段。
  const run = runReadRun(document), operation = runReadOperation(run, operationId)
  const target = document.nodes.find(/* 当前与目标身份匹配的图节点。 */ node => /* 查找操作指定的真实目标节点。 */ node.id === operation.targetId)
  if (!target || !['source', 'news', 'claim'].includes(target.data.kind)) throw new GraphError(409, 'INPUT_STALE', RuntimeMessage.OPERATION_TARGET_IS_MISSING)
  runValidateInputs(document, operation)
  if (actor.role === 'worker' && (!operation.route?.approved || !operation.route.slots.some(/* 当前与 Worker 角色槽位匹配的已批准路由项。 */ slot => /* 确认 Worker 绑定的槽位存在于已批准路由。 */ slot.id === actor.slotId))) throw new GraphError(403, 'SLOT_NOT_ALLOWED', RuntimeMessage.WORKER_HAS_NO_APPROVED_SLOT)
  const context = document.nodes.flatMap(/* 当前判断是否应投影进执行上下文的图节点。 */ node => /* 仅把冻结输入中的新闻投影为执行上下文，保留允许 AI 使用的附加字段。 */ node.data.kind === 'news' && operation.inputRefs.some(/* 当前判断新闻是否属于冻结输入的节点引用。 */ ref => /* 判断该新闻是否属于本操作冻结的输入范围。 */ ref.id === node.id)
    ? [{ id: node.id, content: node.data.content, context: Object.fromEntries(Object.entries(node.data.context).filter((/* 新闻上下文中当前检查 AI 可见性的字段记录。 */ [, field]) => /* 过滤新闻上下文中不允许向 AI 展示的字段。 */ field.visibleToAI)) }] : [])
  const projected = structuredClone(target) as GraphDataRead['target']
  if (projected.data.kind === 'news') projected.data.context = Object.fromEntries(Object.entries(projected.data.context).filter((/* 目标新闻副本中当前检查 AI 可见性的字段记录。 */ [, field]) => /* 对目标新闻副本执行相同的上下文可见性过滤。 */ field.visibleToAI))
  return { mapId: document.id, runId: run.id, operationId, operationKind: operation.kind, target: projected, context,
    ...(operation.rawContent === undefined ? {} : { rawContent: operation.rawContent }), configuration: run.configuration,
    route: operation.route, reports: operation.reports, splitReports: operation.splitReports, draft: operation.draft, contentDraft: operation.contentDraft,
    review: operation.review, phase: runReadPhase(operation), proposalId: runReadProposalId(operation, actor) }
}
export function runUpdateProposal(/* 将在原地接纳路由、报告或汇总草稿的图草稿。 */ document: GraphDocument, /* DSH 提交的结构化阶段产物和稳定提案身份。 */ proposal: GraphDataProposal, /* 从租约授权取得、用于限制可提交阶段和槽位的角色。 */ actor: GraphDataActor, /* 提案接纳、审核和进度变化共同使用的 ISO 时间。 */ now: string) {
  // 校验提案的阶段、角色和输入，在图草稿中接纳报告或产物，建立所需审核并推进 Run。
  const run = runReadExecution(document), operation = runReadOperation(run, proposal.operationId)
  if (run.paused || operation.status !== 'running') throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.OPERATION_IS_NOT_EXECUTABLE)
  if (proposal.id !== runReadProposalId(operation, actor)) throw new GraphError(409, 'PROPOSAL_CONFLICT', RuntimeMessage.PROPOSAL_IDENTITY_DOES_NOT_MATCH_OPERATION_ROUTE_SLOT)
  runValidateInputs(document, operation)
  let result = { nodeIds: [] as string[], edgeIds: [] as string[] }
  if (proposal.kind === 'parse') {
    if (operation.kind !== 'parse' || actor.role !== 'parse') throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.ONLY_PARSE_WORK_MAY_SUBMIT_NEWS)
    operation.contentDraft = { kind: 'parse', reason: proposal.reason, news: structuredClone(proposal.news) }
    // 人工模式先保留草稿等待审核；自动模式立即把产物及关系写入图草稿。
    if (run.mode === 'human-in-loop') runCreateReview(operation, 'result', now)
    else result = runCreateOutputs(document, operation, now)
  } else if (proposal.kind === 'route') {
    if (operation.kind === 'parse' || actor.role !== 'router') throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.ONLY_ROUTER_MAY_SUBMIT_A_ROUTE)
    if (operation.route) throw new GraphError(409, 'ROUTE_EXISTS', RuntimeMessage.ROUTE_HAS_ALREADY_BEEN_SUBMITTED)
    operation.route = { revision: 1, reason: proposal.reason, slots: runValidateSlots(run, operation, proposal.slots), approved: run.mode === 'auto' }
    if (run.mode === 'human-in-loop') runCreateReview(operation, 'route', now)
  } else {
    const route = operation.route
    if (!route?.approved || route.revision !== proposal.routeRevision) throw new GraphError(409, 'ROUTE_NOT_APPROVED', RuntimeMessage.NO_MATCHING_APPROVED_ROUTE)
    const split = operation.kind === 'split'
    if ((split && !['split-report', 'split-merge'].includes(proposal.kind)) || (!split && !['report', 'merge'].includes(proposal.kind))) throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_OPERATION_KIND)
    const reports = split ? operation.splitReports : operation.reports
    if (proposal.kind === 'report' || proposal.kind === 'split-report') {
      if (actor.role !== 'worker' || actor.slotId !== proposal.slotId) throw new GraphError(403, 'SLOT_NOT_ALLOWED', RuntimeMessage.WORKER_MAY_ONLY_SUBMIT_ITS_BOUND_SLOT)
      const slot = route.slots.find(/* 当前与 Worker 提案槽位身份匹配的批准路由项。 */ slot => /* 找到提案绑定的已批准路由槽位。 */ slot.id === proposal.slotId)
      if (!slot) throw new GraphError(403, 'SLOT_NOT_ALLOWED', RuntimeMessage.UNKNOWN_ROUTE_SLOT)
      if (reports.some(/* 当前检查该槽位是否已经接纳报告的记录。 */ report => /* 每个槽位只能接纳一份报告。 */ report.slotId === slot.id)) throw new GraphError(409, 'REPORT_SLOT_CONFLICT', RuntimeMessage.SLOT_ALREADY_HAS_A_REPORT)
      const configuration = split ? run.configuration.split! : run.configuration
      const profile = configuration.agents.find(/* 当前与路由槽位 Agent 身份匹配的冻结配置。 */ agent => /* 从本 Run 保存的配置取得槽位 Agent 的身份与名称。 */ agent.id === slot.agentId)!
      const base = { id: proposal.id, slotId: slot.id, agentId: profile.id, agentName: profile.name, angle: slot.angle,
        tools: [...slot.tools], routeRevision: route.revision, reason: proposal.reason, createdAt: now }
      if (proposal.kind === 'split-report') operation.splitReports.push({ ...base, claims: structuredClone(proposal.claims) })
      else operation.reports.push({ ...base, score: proposal.score })
    } else {
      if (actor.role !== 'merge') throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.ONLY_MERGER_MAY_SUBMIT_RESULTS)
      // 槽位覆盖与报告身份分别核对，要求汇总恰好引用每份已接纳报告一次。
      if (reports.length !== route.slots.length || !route.slots.every(/* 当前检查是否已有对应报告的路由槽位。 */ slot =>
        /* 检查每个路由槽位都已有报告。 */ reports.some(/* 当前与槽位身份比较的已接纳报告。 */ report => /* 按槽位身份确认报告归属。 */ report.slotId === slot.id))
        || new Set(proposal.reportIds).size !== reports.length || proposal.reportIds.length !== reports.length
        || !reports.every(/* 当前检查是否被汇总提案完整引用的报告。 */ report => /* 确认汇总未漏掉任何已接纳报告。 */ proposal.reportIds.includes(report.id))) throw new GraphError(409, 'REPORTS_INCOMPLETE', RuntimeMessage.MERGE_MUST_REFERENCE_EVERY_ACCEPTED_REPORT_EXACTLY_ONCE)
      if (proposal.kind === 'split-merge') {
        const keys = new Set<string>()
        for (const item of proposal.selected) {
          const report = operation.splitReports.find(/* 当前与拆分汇总选择的报告身份匹配的报告。 */ report => /* 只允许选择已接纳拆分报告中的候选事实。 */ report.id === item.reportId), key = item.reportId + ':' + item.index
          if (!report || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= report.claims.length || keys.has(key)) throw new GraphError(422, 'INVALID_SELECTION', RuntimeMessage.SELECT_EACH_EXISTING_CANDIDATE_AT_MOST_ONCE)
          keys.add(key)
        }
        operation.contentDraft = { kind: 'split', reason: proposal.reason, selected: structuredClone(proposal.selected) }
      } else operation.draft = { id: proposal.id, routeRevision: route.revision, reportIds: [...proposal.reportIds], score: proposal.score, reason: proposal.reason }
      if (run.mode === 'human-in-loop') runCreateReview(operation, 'result', now)
      else result = runCreateOutputs(document, operation, now)
    }
  }
  runUpdateProgress(document, now)
  return { document, ...result }
}
