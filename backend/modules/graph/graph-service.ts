// 协调图命令、幂等收据、版本提交和工作租约，将草稿更新提交到存储。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type {
  GraphChanges,
  GraphCommand,
  GraphDataProposal,
  GraphDataRead,
  GraphEdge,
  GraphMapSummary,
  GraphNode,
  GraphQuery,
  GraphSnapshot,
  GraphWriteResult,
  GraphRunConfiguration,
  GraphRun,
  GraphWorkCommand,
  GraphWorkProof,
} from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import type { GraphClaimResult } from '../../../contracts/events'
import {
  runAnswerReview,
  runCancelRun,
  runCreateRun,
  runReadData,
  runUpdateProposal,
  runUpdateReview,
  runUpdatePause,
  runReadOperation,
} from './run-state'
import type { GraphDocument, GraphReceipt } from './graph-record'
import type { GraphStore } from '../../ports/graph-store'
import { storeCreateInputHash } from './graph-record'
import { workReadGrant, workReadItems } from './work-state'

export function graphReadSnapshot(/* 包含当前图、运行历史和产物关系的持久化文档。 */ document: GraphDocument): GraphSnapshot {
  // 从当前与历史 Run 还原解析、拆分节点的产出来源，生成不含租约和收据的公开图快照。
  const producers = new Map<string, NonNullable<GraphNode['producer']>>()
  for (const run of [...document.runHistory, ...(document.run ? [document.run] : [])]) {
    for (const operation of run.operations) {
      if (operation.kind === 'verify') continue
      for (const output of operation.outputRefs) {
        if (!document.edges.some(/* 当前检查是否仍把某个历史产物连接到其输入的关系。 */ edge => /* 只为仍保留来源关系的产物标注生成者。 */ edge.kind === 'derived-from' && edge.from === output.id && edge.to === operation.targetId)) continue
        const report = operation.splitReports.find(/* 当前与产物记录的报告身份匹配的拆分报告。 */ report => /* 找到该产物对应的拆分报告及 Agent 身份。 */ report.id === output.reportId)
        const agent = operation.kind === 'parse' ? run.configuration.parse : report
        if (!agent) continue
        producers.set(output.id, { operationId: operation.id, kind: operation.kind, inputId: operation.targetId,
          agentId: 'agentId' in agent ? agent.agentId : agent.id, agentName: 'agentName' in agent ? agent.agentName : agent.name,
          ...(report ? { slotId: report.slotId, angle: report.angle } : {}) })
      }
    }
  }
  return {
    mapId: document.id,
    workspaceId: document.workspaceId,
    revision: document.revision,
    name: document.name,
    nodes: document.nodes.map(/* 准备投影为公开快照并按需补充生产者信息的节点。 */ node => /* 仅为可追溯到生成操作的节点补充 producer，不修改原节点。 */ producers.has(node.id) ? { ...node, producer: producers.get(node.id)! } : node),
    edges: document.edges,
    run: document.run,
    updatedAt: document.updatedAt,
  }
}

function graphReadReceipt(
  /* 包含待查幂等收据的当前图文档。 */ document: GraphDocument,
  /* 当前收据幂等键；公共命令按用户隔离，内部提案和失败记录使用相应工作键。 */ requestId: string,
  /* 这次请求声明的命令或内部提交方法。 */ method: string,
  /* 按当前操作规则计算的稳定摘要；公共命令使用方法与参数，内部提案或失败使用各自业务输入。 */ inputHash: string,
): GraphReceipt | null {
  // 查找已提交请求；相同请求 ID 只有方法和输入摘要均相同才允许重放。
  const receipt = document.receipts.find(/* 当前与目标请求身份比较的已提交收据。 */ item => /* 定位该请求已经持久化的收据。 */ item.requestId === requestId)
  if (!receipt) return null
  if (receipt.method !== method || receipt.inputHash !== inputHash) {
    throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_WAS_ALREADY_USED_WITH_DIFFERENT_INPUT)
  }
  return receipt
}

function graphCreateWriteResult(/* 提交或重放后用于生成当前公开快照的图文档。 */ document: GraphDocument, /* 记录此次请求实际创建对象身份的已接纳收据。 */ receipt: GraphReceipt): GraphWriteResult {
  // 将当前快照与原收据中的新建 ID 组合返回；重放不会还原提交当时的整个快照。
  return {
    snapshot: graphReadSnapshot(document),
    createdNodeIds: receipt.createdNodeIds,
    createdEdgeIds: receipt.createdEdgeIds,
  }
}

function graphCreateReceipt(
  /* 需要在图内唯一标识一次请求或工作结果的身份。 */ requestId: string,
  /* 收据绑定的公共命令或内部提交方法。 */ method: string,
  /* 请求业务输入的稳定摘要。 */ inputHash: string,
  /* 创建该收据及业务变更的 ISO 时间。 */ now: string,
  /* 本次提交新建的节点身份；没有节点时保持空数组。 */ createdNodeIds: string[] = [],
  /* 本次提交新建的关系身份；没有关系时保持空数组。 */ createdEdgeIds: string[] = [],
): GraphReceipt {
  // 记录请求身份、输入摘要及新建对象 ID，供原子提交和后续幂等重放使用。
  return { requestId, method, inputHash, createdNodeIds, createdEdgeIds, createdAt: now }
}

function graphReadUnique(/* 需要拒绝重复项并转换为集合的身份列表。 */ values: string[], /* 写入重复值错误信息的输入字段名称。 */ label: string): Set<string> {
  // 拒绝同一批变更中的重复 ID，并返回供冲突检查使用的集合。
  const result = new Set(values)
  if (result.size !== values.length) {
    throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTAINS_DUPLICATE_IDS, label))
  }
  return result
}

function graphUpdateChanges(/* 应用编辑前的当前图文档。 */ document: GraphDocument, /* 已经过协议解析、待应用的名称和节点关系变更。 */ changes: GraphChanges): {
  document: GraphDocument
  createdNodeIds: string[]
  createdEdgeIds: string[]
} {
  // 在新的节点和边集合中应用人工编辑，校验关系与类型约束，并返回待提交文档及新建 ID。
  const now = new Date().toISOString()
  const nodePuts = changes.nodes?.put ?? []
  const nodeRemoves = graphReadUnique(changes.nodes?.remove ?? [], 'nodes.remove')
  const edgePuts = changes.edges?.put ?? []
  const edgeRemoves = graphReadUnique(changes.edges?.remove ?? [], 'edges.remove')
  graphReadUnique(nodePuts.map(/* 节点写入列表中当前用于唯一性检查的项。 */ item => /* 提取本批新增或更新节点的 ID。 */ item.id), 'nodes.put')
  graphReadUnique(edgePuts.map(/* 关系写入列表中当前用于唯一性检查的项。 */ item => /* 提取本批新增或更新关系的 ID。 */ item.id), 'edges.put')
  if (nodePuts.some(/* 当前检查是否同时出现在节点删除集合的写入项。 */ item => /* 检查节点是否同时出现在写入和删除列表。 */ nodeRemoves.has(item.id))) {
    throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.A_NODE_CANNOT_BE_PUT_AND_REMOVED_TOGETHER)
  }
  if (edgePuts.some(/* 当前检查是否同时出现在关系删除集合的写入项。 */ item => /* 检查关系是否同时出现在写入和删除列表。 */ edgeRemoves.has(item.id))) {
    throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.AN_EDGE_CANNOT_BE_PUT_AND_REMOVED_TOGETHER)
  }
  if (
    changes.name === undefined
    && nodePuts.length === 0
    && nodeRemoves.size === 0
    && edgePuts.length === 0
    && edgeRemoves.size === 0
  ) {
    throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.GRAPH_APPLY_CONTAINS_NO_CHANGES)
  }

  const nodes = new Map(document.nodes.map(/* 当前加入可变节点索引的原节点。 */ node => /* 建立可独立增删的节点索引，保留未编辑节点。 */ [node.id, node]))
  const edges = new Map(document.edges.map(/* 当前加入可变关系索引的原关系。 */ edge => /* 建立可独立增删的关系索引，保留未编辑关系。 */ [edge.id, edge]))
  for (const nodeId of nodeRemoves) {
    if (!nodes.delete(nodeId)) throw new GraphError(404, 'NODE_NOT_FOUND', messageFormat(RuntimeMessage.NODE_NOT_FOUND_VALUE, nodeId))
    for (const [edgeId, edge] of edges) {
      if (edge.from === nodeId || edge.to === nodeId) edges.delete(edgeId)
    }
  }

  const createdNodeIds: string[] = []
  for (const input of nodePuts) {
    const existing = nodes.get(input.id)
    if (existing && existing.data.kind !== input.data.kind) {
      throw new GraphError(422, 'NODE_KIND_CHANGED', messageFormat(RuntimeMessage.NODE_KIND_CANNOT_CHANGE_VALUE, input.id))
    }
    const node: GraphNode = {
      ...existing,
      id: input.id,
      revision: existing ? existing.revision + 1 : 0,
      data: input.data,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    nodes.set(node.id, node)
    if (!existing) createdNodeIds.push(node.id)
  }

  for (const edgeId of edgeRemoves) {
    if (!edges.delete(edgeId)) throw new GraphError(404, 'EDGE_NOT_FOUND', messageFormat(RuntimeMessage.EDGE_NOT_FOUND_VALUE, edgeId))
  }
  const createdEdgeIds: string[] = []
  for (const input of edgePuts) {
    const from = nodes.get(input.from)
    const to = nodes.get(input.to)
    if (!from || !to) {
      throw new GraphError(422, 'INVALID_RELATION', messageFormat(RuntimeMessage.EDGE_REFERENCES_A_MISSING_NODE_VALUE, input.id))
    }
    if (input.from === input.to) {
      throw new GraphError(422, 'INVALID_RELATION', messageFormat(RuntimeMessage.SELF_EDGE_IS_NOT_ALLOWED_VALUE, input.id))
    }
    if (input.kind === 'mentions' && (from.data.kind !== 'news' || to.data.kind !== 'claim')) {
      throw new GraphError(422, 'INVALID_RELATION', RuntimeMessage.MENTIONS_MUST_POINT_FROM_NEWS_TO_CLAIM)
    }
    if (input.kind === 'verifies' && (from.data.kind !== 'verification' || to.data.kind !== 'claim')) {
      throw new GraphError(422, 'INVALID_RELATION', RuntimeMessage.VERIFIES_MUST_POINT_FROM_VERIFICATION_TO_CLAIM)
    }
    if (input.kind === 'derived-from' && !((from.data.kind === 'news' && to.data.kind === 'source')
      || (from.data.kind === 'claim' && to.data.kind === 'news'))) {
      throw new GraphError(422, 'INVALID_RELATION', RuntimeMessage.DERIVED_FROM_MUST_LINK_NEWS_TO_SOURCE_OR_CLAIM_TO_NEWS)
    }
    const existing = edges.get(input.id)
    const edge: GraphEdge = {
      ...input,
      revision: existing ? existing.revision + 1 : 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    edges.set(edge.id, edge)
    if (!existing) createdEdgeIds.push(edge.id)
  }

  return {
    document: {
      ...document,
      name: changes.name?.trim() || document.name,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      updatedAt: now,
    },
    createdNodeIds,
    createdEdgeIds,
  }
}

export interface GraphServiceOptions { leaseMs?: number; readSource?: (/* 来源节点所属工作区，用于限制资产引用归属；URL 网络访问策略由读取器实施。 */ workspaceId: string, /* 需要读取并冻结正文的来源节点。 */ node: GraphNode) => Promise<string> }
export function graphCreateService(/* 负责最终版本、租约和收据原子条件的图存储。 */ store: GraphStore, /* 可选租约毫秒数和来源正文读取器；租约缺省为 15000，允许范围为 100 至 300000。 */ options: GraphServiceOptions = {}) {
  // 绑定图存储和租约时长，统一处理图命令、工作授权、执行输入与提案提交；用户鉴权由应用层负责。
  const leaseMs = options.leaseMs ?? 15_000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000) throw new Error(RuntimeMessage.LEASEMS_MUST_BE_BETWEEN_100_AND_300000)
  async function graphReadMap(/* 需要读取且不能处于逻辑删除状态的图身份。 */ mapId: string): Promise<GraphDocument> {
    // 读取仍存在的图，将缺失和逻辑删除统一视为不可访问。
    const document = await store.read(mapId)
    if (!document || document.deletedAt) {
      throw new GraphError(404, 'MAP_NOT_FOUND', messageFormat(RuntimeMessage.MAP_NOT_FOUND_VALUE, mapId))
    }
    return document
  }

  async function graphCommit(
    /* 调用方据以计算业务变更的原图快照。 */ original: GraphDocument,
    /* 应用业务变化但尚未推进持久化版本的图草稿。 */ updated: GraphDocument,
    /* 必须与图状态一起提交的请求收据。 */ receipt: GraphReceipt,
  ): Promise<{ document: GraphDocument; replayed: boolean }> {
    // 按原版本原子提交变更与收据；提交未匹配时，查最新收据区分并发重复请求与版本冲突。
    if (await store.commit(updated, original.revision, receipt)) {
      const committed = await store.read(updated.id)
      if (!committed) throw new Error(messageFormat(RuntimeMessage.COMMITTED_MAP_DISAPPEARED_VALUE, updated.id))
      return { document: committed, replayed: false }
    }
    const latest = await store.read(updated.id)
    if (!latest) throw new GraphError(404, 'MAP_NOT_FOUND', messageFormat(RuntimeMessage.MAP_NOT_FOUND_VALUE, updated.id))
    const replay = graphReadReceipt(latest, receipt.requestId, receipt.method, receipt.inputHash)
    if (replay) return { document: latest, replayed: true }
    throw new GraphError(
      409,
      'REVISION_CONFLICT',
      messageFormat(RuntimeMessage.MAP_REVISION_CHANGED_VALUE, updated.id),
      latest.revision,
    )
  }

  return {
    async read(/* 已经过应用层授权解析的图查询。 */ query: GraphQuery): Promise<GraphSnapshot | GraphMapSummary[] | GraphRun> {
      // 返回工作区图列表、公开快照或指定的当前/历史 Run；不存在的图和 Run 会报错。
      if (query.method === 'map.list') return store.list(query.params.workspaceId)
      const document = await graphReadMap(query.params.mapId)
      if (query.method === 'run.get') {
        const run = document.run?.id === query.params.runId ? document.run : document.runHistory.find(/* 当前与指定历史运行身份比较的 Run。 */ run => /* 当前 Run 不匹配时，从历史中寻找指定运行。 */ run.id === query.params.runId)
        if (!run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.RUN_NOT_FOUND)
        return run
      }
      return graphReadSnapshot(document)
    },

    async dispatch(/* 已经过协议和用户作用域处理的图命令。 */ command: GraphCommand, /* 启动 Run 时由工作区解析并冻结的可选执行配置。 */ configuration?: GraphRunConfiguration): Promise<{
      data: GraphWriteResult | { mapId: string; deleted: true }
      replayed: boolean
    }> {
      // 重放已完成命令，或在版本校验后提交图、Run 与审核变更；收据和状态由存储层一起写入。
      // 摘要包含 expectedRevision；网络重试必须原样重发，不能只保留 requestId 而改写版本。
      const inputHash = storeCreateInputHash({ method: command.method, params: command.params })
      const now = new Date().toISOString()

      if (command.method === 'map.create') {
        // 重复插入会中止 Mongo 事务，因此先读取已有收据，确认是否可以直接重放。
        const prior = await store.read(command.params.id)
        if (prior) {
          const replay = graphReadReceipt(prior, command.requestId, command.method, inputHash)
          if (!replay || prior.deletedAt) throw new GraphError(409, 'MAP_EXISTS', messageFormat(RuntimeMessage.MAP_ALREADY_EXISTS_VALUE, prior.id))
          return { data: graphCreateWriteResult(prior, replay), replayed: true }
        }
        const receipt: GraphReceipt = {
          requestId: command.requestId,
          method: command.method,
          inputHash,
          createdNodeIds: [],
          createdEdgeIds: [],
          createdAt: now,
        }
        const document: GraphDocument = {
          id: command.params.id,
          workspaceId: command.params.workspaceId,
          revision: 0,
          name: command.params.name.trim(),
          nodes: [],
          edges: [],
          run: null,
          runHistory: [],
          leases: {},
          receipts: [receipt],
          createdAt: now,
          updatedAt: now,
        }
        if (!document.name) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.MAP_NAME_MUST_NOT_BE_EMPTY)
        if (await store.create(document)) {
          return { data: graphCreateWriteResult(document, receipt), replayed: false }
        }
        const existing = await store.read(document.id)
        if (!existing) throw new Error(messageFormat(RuntimeMessage.DUPLICATE_MAP_DISAPPEARED_VALUE, document.id))
        const replay = graphReadReceipt(existing, command.requestId, command.method, inputHash)
        if (!replay || existing.deletedAt) {
          throw new GraphError(409, 'MAP_EXISTS', messageFormat(RuntimeMessage.MAP_ALREADY_EXISTS_VALUE, document.id))
        }
        return { data: graphCreateWriteResult(existing, replay), replayed: true }
      }

      const document = await store.read(command.params.mapId)
      if (!document) throw new GraphError(404, 'MAP_NOT_FOUND', messageFormat(RuntimeMessage.MAP_NOT_FOUND_VALUE, command.params.mapId))
      // 收据优先于当前版本检查，避免成功请求因后续写入改变 revision 而重试失败。
      const priorReceipt = graphReadReceipt(document, command.requestId, command.method, inputHash)
      if (priorReceipt) {
        if (command.method === 'map.delete') {
          return { data: { mapId: document.id, deleted: true }, replayed: true }
        }
        if (document.deletedAt) throw new GraphError(410, 'MAP_GONE', messageFormat(RuntimeMessage.MAP_WAS_DELETED_VALUE, document.id))
        return { data: graphCreateWriteResult(document, priorReceipt), replayed: true }
      }
      if (document.deletedAt) throw new GraphError(410, 'MAP_GONE', messageFormat(RuntimeMessage.MAP_WAS_DELETED_VALUE, document.id))
      if (document.revision !== command.params.expectedRevision) {
        throw new GraphError(409, 'REVISION_CONFLICT',
          messageFormat(RuntimeMessage.EXPECTED_REVISION_VALUE_FOUND_VALUE, command.params.expectedRevision, document.revision), document.revision)
      }

      if (command.method === 'map.delete') {
        if (document.run && ['running', 'waiting'].includes(document.run.status)) {
          throw new GraphError(409, 'RUN_ACTIVE', RuntimeMessage.ACTIVE_RUN_MUST_BE_CANCELLED_BEFORE_DELETING_MAP)
        }
        const receipt: GraphReceipt = {
          requestId: command.requestId,
          method: command.method,
          inputHash,
          createdNodeIds: [],
          createdEdgeIds: [],
          createdAt: now,
        }
        const result = await graphCommit(document, { ...document, deletedAt: now, updatedAt: now }, receipt)
        return { data: { mapId: result.document.id, deleted: true }, replayed: result.replayed }
      }

      if (command.method === 'run.start') {
        if (!configuration) throw new GraphError(422, 'CONFIGURATION_REQUIRED', RuntimeMessage.RUN_REQUIRES_A_RESOLVED_WORKSPACE_CONFIGURATION)
        const updated = runCreateRun(structuredClone(document), command.params, configuration, now)
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now)
        const result = await graphCommit(document, updated, receipt)
        return { data: graphCreateWriteResult(result.document, receipt), replayed: result.replayed }
      }

      if (command.method === 'run.cancel') {
        const updated = runCancelRun(structuredClone(document), command.params.runId, now)
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now)
        const result = await graphCommit(document, updated, receipt)
        return { data: graphCreateWriteResult(result.document, receipt), replayed: result.replayed }
      }

      if (command.method === 'run.pause' || command.method === 'run.resume') {
        const updated = runUpdatePause(structuredClone(document), command.params.runId, command.method === 'run.pause', now)
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now)
        const result = await graphCommit(document, updated, receipt)
        return { data: graphCreateWriteResult(result.document, receipt), replayed: result.replayed }
      }

      if (command.method === 'review.answer') {
        const update = runAnswerReview(structuredClone(document), command.params, now)
        const receipt = graphCreateReceipt(
          command.requestId,
          command.method,
          inputHash,
          now,
          update.nodeIds,
          update.edgeIds,
        )
        const result = await graphCommit(document, update.document, receipt)
        const acceptedReceipt = result.document.receipts.find(/* 提交后的图中当前与审核请求身份匹配的实际收据。 */ item => /* 使用实际提交者记录的产物 ID，兼容并发重放。 */ item.requestId === command.requestId)!
        return { data: graphCreateWriteResult(result.document, acceptedReceipt), replayed: result.replayed }
      }

      if (command.method === 'review.update') {
        const updated = runUpdateReview(structuredClone(document), command.params, now)
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now)
        const result = await graphCommit(document, updated, receipt)
        return { data: graphCreateWriteResult(result.document, receipt), replayed: result.replayed }
      }

      if (document.run && ['running', 'waiting'].includes(document.run.status)) {
        throw new GraphError(409, 'RUN_ACTIVE', RuntimeMessage.GRAPH_CANNOT_BE_EDITED_WHILE_A_RUN_IS_ACTIVE)
      }

      const change = graphUpdateChanges(document, command.params.changes)
      const receipt: GraphReceipt = {
        requestId: command.requestId,
        method: command.method,
        inputHash,
        createdNodeIds: change.createdNodeIds,
        createdEdgeIds: change.createdEdgeIds,
        createdAt: now,
      }
      const result = await graphCommit(document, change.document, receipt)
      const acceptedReceipt = result.document.receipts.find(/* 提交后的图中当前与图编辑请求身份匹配的实际收据。 */ item => /* 从提交后的文档取得本次请求最终接纳的收据。 */ item.requestId === command.requestId)
      if (!acceptedReceipt) throw new Error(messageFormat(RuntimeMessage.COMMITTED_RECEIPT_DISAPPEARED_VALUE, command.requestId))
      return {
        data: graphCreateWriteResult(result.document, acceptedReceipt),
        replayed: result.replayed,
      }
    },

    async dispatchWork(/* 来自内部工作 API 的领取、续租、读取、释放或失败命令。 */ command: GraphWorkCommand) {
      // 处理 Work 的领取、续租、结果状态查询、释放和失败提交，以存储层租约条件仲裁并发执行。
      if (command.method === 'claim') {
        const input = command.params
        for (let attempt = 0; attempt < 64; attempt++) {
          const document = await store.read(input.mapId)
          if (!document || document.deletedAt) return { status: 'obsolete' } satisfies GraphClaimResult
          // 队列消息只提供工作线索；每次领取都根据当前图重新确认工作是否仍可执行。
          const work = workReadItems(document).find(/* 当前与队列通知身份匹配的可执行工作。 */ item => /* 匹配通知中指定的、当前可执行的工作。 */ item.workId === input.workId)
          if (!work || document.receipts.some(/* 当前判断是否已有成功结果的工作收据。 */ receipt => /* 已接纳结果的工作不再重复领取。 */ receipt.requestId === input.workId)) return { status: 'obsolete' } satisfies GraphClaimResult
          const prior = document.leases[input.workId]
          if (prior && prior.holderId === input.holderId && prior.hostId === input.hostId) {
            const current = await store.readLease(document.id, prior)
            if (current) return { status: 'claimed', grant: current.leases[input.workId] } satisfies GraphClaimResult
          }
          const grant = await store.claim(document, work, input.hostId, input.holderId, leaseMs)
          if (grant) return { status: 'claimed', grant } satisfies GraphClaimResult
          const retryAfterMs = await store.readLeaseDelay(input.mapId, input.workId)
          if (retryAfterMs > 0) return { status: 'busy', retryAfterMs } satisfies GraphClaimResult
        }
        throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_CLAIM_AFTER_CONCURRENT_UPDATES_SETTLE)
      }
      if (command.method === 'renew') {
        const grant = await store.renew(command.params.mapId, command.params)
        if (!grant) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_EXPIRED_WAS_CANCELLED_OR_WAS_SUPERSEDED)
        return grant
      }
      if (command.method === 'read') {
        const input = command.params
        const document = await graphReadMap(input.mapId)
        // 提交后租约可能已经到期；此处先确认结果是否已接纳，再判断未完成工作是否仍持有有效租约。
        if (document.leases[input.workId] && document.receipts.some(/* 当前判断工作读取是否已被接纳的成功收据。 */ receipt => /* 检查工作结果是否已形成成功收据。 */ receipt.requestId === input.workId)) {
          return { workId: input.workId, status: 'accepted' as const }
        }
        workReadGrant(document, input)
        if (!await store.readLease(input.mapId, input)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        return { workId: input.workId, status: 'ready' as const }
      }
      if (command.method === 'release') return { released: await store.release(command.params.mapId, command.params) }
      const failure = command.params
      const failureId = `${failure.workId}:failure:${failure.fence}`
      const failureHash = storeCreateInputHash({ workId: failure.workId, message: failure.message })
      for (let attempt = 0; attempt < 64; attempt++) {
        const document = await graphReadMap(failure.mapId)
        const grant = workReadGrant(document, failure)
        if (graphReadReceipt(document, failureId, 'work.fail', failureHash)) return { failed: true }
        if (document.receipts.some(/* 当前判断迟到失败是否会覆盖成功结果的收据。 */ receipt => /* 已成功的工作不能被迟到的失败报告覆盖。 */ receipt.requestId === failure.workId)) return { failed: false }
        if (!await store.readLease(document.id, failure)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.CANNOT_FAIL_WORK_WITHOUT_ITS_LEASE)
        if (!workReadItems(document).some(/* 当前与失败上报工作身份比较的可执行工作。 */ work => /* 仅允许把仍可执行的工作标记为失败。 */ work.workId === failure.workId)) return { failed: false }
        const updated = structuredClone(document)
        updated.run!.status = 'failed'
        runReadOperation(updated.run!, grant.operationId).status = 'failed'
        updated.run!.error = { code: 'EXECUTION_FAILED', message: failure.message, workId: failure.workId }
        updated.updatedAt = updated.run!.updatedAt = new Date().toISOString()
        const receipt = graphCreateReceipt(failureId, 'work.fail', failureHash, updated.updatedAt)
        if (await store.commit(updated, document.revision, receipt, grant)) return { failed: true }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_WORK_FAILURE_AFTER_CONCURRENT_UPDATES_SETTLE)
    },

    async readData(/* 需要读取执行输入的图身份。 */ mapId: string, /* 授权限定的 Operation 身份。 */ operationId: string, /* 读取者的 work、holder 和 fence 证明。 */ proof: GraphWorkProof): Promise<GraphDataRead> {
      // 按工作角色投影执行输入；首次解析来源时还会读取正文并持久化到 Operation，冻结本轮输入。
      let document = await graphReadMap(mapId)
      const grant = workReadGrant(document, proof)
      if (grant.operationId !== operationId) throw new GraphError(403, 'WORK_SCOPE_MISMATCH', RuntimeMessage.GRANT_BELONGS_TO_ANOTHER_OPERATION)
      // 已接纳工作仍需匹配 holder/fence，但读取既有输入时不再要求租约尚未到期。
      const accepted = document.receipts.some(/* 当前判断工作结果是否已接纳、可放宽时效检查的收据。 */ receipt => /* 区分结果确认与仍需租约保护的执行读取。 */ receipt.requestId === proof.workId)
      if (!accepted) {
        const leased = await store.readLease(mapId, proof)
        if (!leased) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        document = leased
      }
      const operation = runReadOperation(document.run!, operationId)
      if (operation.kind === 'parse' && operation.rawContent === undefined) {
        if (!options.readSource) throw new GraphError(503, 'SOURCE_UNAVAILABLE', RuntimeMessage.SOURCE_READER_IS_NOT_CONFIGURED)
        const data = runReadData(document, operationId, grant.actor)
        // 本次调用中的慢来源读取只做一次；提交竞争时重读图，优先使用其他请求已保存的正文。
        const rawContent = await options.readSource(document.workspaceId, data.target)
        for (let attempt = 0; attempt < 64; attempt++) {
          document = await graphReadMap(mapId)
          const current = runReadOperation(document.run!, operationId)
          if (current.rawContent !== undefined) break
          runReadData(document, operationId, grant.actor)
          const updated = structuredClone(document)
          runReadOperation(updated.run!, operationId).rawContent = rawContent
          updated.updatedAt = new Date().toISOString()
          const receipt = graphCreateReceipt(operationId + ':input', 'source.read', storeCreateInputHash({ rawContent, inputRefs: current.inputRefs }), updated.updatedAt)
          if (await store.commit(updated, document.revision, receipt, grant)) { document = await graphReadMap(mapId); break }
          if (!await store.readLease(mapId, proof)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.SOURCE_READ_LOST_ITS_WORK_LEASE)
          if (attempt === 63) throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_SOURCE_READ_AFTER_CONCURRENT_UPDATES_SETTLE)
        }
        if (!await store.readLease(mapId, proof)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.SOURCE_READ_LOST_ITS_WORK_LEASE)
      }
      return { ...runReadData(document, operationId, grant.actor),
        work: { id: grant.workId, actor: grant.actor, routeRevision: grant.routeRevision,
          status: document.receipts.some(/* 最终图中当前判断执行输入工作是否已接纳的收据。 */ receipt => /* 根据最终文档标记工作结果是否已接纳。 */ receipt.requestId === proof.workId) ? 'accepted' : 'ready' },
      }
    },

    async propose(/* DSH 提交且尚未接纳或确认重放的结构化业务提案。 */ proposal: GraphDataProposal, /* 提案提交者的 work、holder 和 fence 证明。 */ proof: GraphWorkProof): Promise<GraphSnapshot> {
      // 核对工作角色与提案身份，重放已接纳结果，或在有效租约下原子写入产物并推进 Run。
      const method = `proposal.${proposal.kind}`
      // 不同槽位报告可同时提交；竞争失败后只重新校验和应用同一提案，不重新调用模型。
      for (let attempt = 0; attempt < 64; attempt++) {
        const document = await graphReadMap(proposal.mapId)
        const grant = document.leases[proof.workId]
        if (!grant) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_GRANT_DOES_NOT_EXIST)
        const actor = grant.actor
        if (proposal.id !== grant.workId || proposal.operationId !== grant.operationId
          || (proposal.kind === 'parse' && actor.role !== 'parse')
          || (proposal.kind === 'route' && actor.role !== 'router')
          || ((proposal.kind === 'merge' || proposal.kind === 'split-merge') && actor.role !== 'merge')
          || ((proposal.kind === 'report' || proposal.kind === 'split-report') && (actor.role !== 'worker' || actor.slotId !== proposal.slotId))) {
          throw new GraphError(403, 'WORK_SCOPE_MISMATCH', RuntimeMessage.PROPOSAL_DOES_NOT_BELONG_TO_THIS_WORK_GRANT)
        }
        const inputHash = storeCreateInputHash({ proposal, actor })
        // grant 和提案角色仍须匹配；已有成功收据则可在租约到期或换持有者后确认原结果。
        const priorReceipt = graphReadReceipt(document, proposal.id, method, inputHash)
        if (priorReceipt) return graphReadSnapshot(document)
        workReadGrant(document, proof)
        if (!await store.readLease(proposal.mapId, proof)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        const view = runReadData(document, proposal.operationId, actor)
        if (view.proposalId !== proposal.id) throw new GraphError(409, 'PROPOSAL_CONFLICT', RuntimeMessage.STALE_PROPOSAL_IDENTITY)
        const now = new Date().toISOString()
        const update = runUpdateProposal(structuredClone(document), proposal, actor, now)
        const receipt = graphCreateReceipt(proposal.id, method, inputHash, now,
          update.nodeIds, update.edgeIds)
        // 前面的读检查不足以抵御并发接管；最终写入仍必须同时匹配图版本和有效租约。
        if (await store.commit(update.document, document.revision, receipt, grant)) {
          return graphReadSnapshot(await graphReadMap(document.id))
        }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_THE_SAME_PROPOSAL_AFTER_CONCURRENT_UPDATES_SETTLE)
    },
  }
}

export type GraphService = ReturnType<typeof graphCreateService>
