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

// 用途：读取快照，并把结构化结果交给调用方。
export function graphReadSnapshot(document: GraphDocument): GraphSnapshot {
  const producers = new Map<string, NonNullable<GraphNode['producer']>>()
  for (const run of [...document.runHistory, ...(document.run ? [document.run] : [])]) {
    for (const operation of run.operations) {
      if (operation.kind === 'verify') continue
      for (const output of operation.outputRefs) {
        if (!document.edges.some(edge => edge.kind === 'derived-from' && edge.from === output.id && edge.to === operation.targetId)) continue
        const report = operation.splitReports.find(report => report.id === output.reportId)
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
    nodes: document.nodes.map(node => producers.has(node.id) ? { ...node, producer: producers.get(node.id)! } : node),
    edges: document.edges,
    run: document.run,
    updatedAt: document.updatedAt,
  }
}

// 用途：读取收据，并把结构化结果交给调用方。
function graphReadReceipt(
  document: GraphDocument,
  requestId: string,
  method: string,
  inputHash: string,
): GraphReceipt | null {
  const receipt = document.receipts.find(item => item.requestId === requestId)
  if (!receipt) return null
  if (receipt.method !== method || receipt.inputHash !== inputHash) {
    throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_WAS_ALREADY_USED_WITH_DIFFERENT_INPUT)
  }
  return receipt
}

// 用途：创建结果，供后续流程使用。
function graphCreateWriteResult(document: GraphDocument, receipt: GraphReceipt): GraphWriteResult {
  return {
    snapshot: graphReadSnapshot(document),
    createdNodeIds: receipt.createdNodeIds,
    createdEdgeIds: receipt.createdEdgeIds,
  }
}

// 用途：创建收据，供后续流程使用。
function graphCreateReceipt(
  requestId: string,
  method: string,
  inputHash: string,
  now: string,
  createdNodeIds: string[] = [],
  createdEdgeIds: string[] = [],
): GraphReceipt {
  return { requestId, method, inputHash, createdNodeIds, createdEdgeIds, createdAt: now }
}

// 用途：读取唯一性，并把结构化结果交给调用方。
function graphReadUnique(values: string[], label: string): Set<string> {
  const result = new Set(values)
  if (result.size !== values.length) {
    throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTAINS_DUPLICATE_IDS, label))
  }
  return result
}

// 用途：更新变更，并保持相关状态一致。
function graphUpdateChanges(document: GraphDocument, changes: GraphChanges): {
  document: GraphDocument
  createdNodeIds: string[]
  createdEdgeIds: string[]
} {
  const now = new Date().toISOString()
  const nodePuts = changes.nodes?.put ?? []
  const nodeRemoves = graphReadUnique(changes.nodes?.remove ?? [], 'nodes.remove')
  const edgePuts = changes.edges?.put ?? []
  const edgeRemoves = graphReadUnique(changes.edges?.remove ?? [], 'edges.remove')
  graphReadUnique(nodePuts.map(item => item.id), 'nodes.put')
  graphReadUnique(edgePuts.map(item => item.id), 'edges.put')
  if (nodePuts.some(item => nodeRemoves.has(item.id))) {
    throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.A_NODE_CANNOT_BE_PUT_AND_REMOVED_TOGETHER)
  }
  if (edgePuts.some(item => edgeRemoves.has(item.id))) {
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

  const nodes = new Map(document.nodes.map(node => [node.id, node]))
  const edges = new Map(document.edges.map(edge => [edge.id, edge]))
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

export interface GraphServiceOptions { leaseMs?: number; readSource?: (workspaceId: string, node: GraphNode) => Promise<string> }
// 用途：创建服务，供后续流程使用。
export function graphCreateService(store: GraphStore, options: GraphServiceOptions = {}) {
  const leaseMs = options.leaseMs ?? 15_000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000) throw new Error(RuntimeMessage.LEASEMS_MUST_BE_BETWEEN_100_AND_300000)
  // 用途：读取数据图，并把结构化结果交给调用方。
  async function graphReadMap(mapId: string): Promise<GraphDocument> {
    const document = await store.read(mapId)
    if (!document || document.deletedAt) {
      throw new GraphError(404, 'MAP_NOT_FOUND', messageFormat(RuntimeMessage.MAP_NOT_FOUND_VALUE, mapId))
    }
    return document
  }

  // 用途：提交数据图，并保持相关状态一致。
  async function graphCommit(
    original: GraphDocument,
    updated: GraphDocument,
    receipt: GraphReceipt,
  ): Promise<{ document: GraphDocument; replayed: boolean }> {
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
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async read(query: GraphQuery): Promise<GraphSnapshot | GraphMapSummary[] | GraphRun> {
      if (query.method === 'map.list') return store.list(query.params.workspaceId)
      const document = await graphReadMap(query.params.mapId)
      if (query.method === 'run.get') {
        const run = document.run?.id === query.params.runId ? document.run : document.runHistory.find(run => run.id === query.params.runId)
        if (!run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.RUN_NOT_FOUND)
        return run
      }
      return graphReadSnapshot(document)
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async dispatch(command: GraphCommand, configuration?: GraphRunConfiguration): Promise<{
      data: GraphWriteResult | { mapId: string; deleted: true }
      replayed: boolean
    }> {
      const inputHash = storeCreateInputHash({ method: command.method, params: command.params })
      const now = new Date().toISOString()

      if (command.method === 'map.create') {
        // A duplicate insert aborts Mongo transactions; replay before attempting the insert.
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
        const acceptedReceipt = result.document.receipts.find(item => item.requestId === command.requestId)!
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
      const acceptedReceipt = result.document.receipts.find(item => item.requestId === command.requestId)
      if (!acceptedReceipt) throw new Error(messageFormat(RuntimeMessage.COMMITTED_RECEIPT_DISAPPEARED_VALUE, command.requestId))
      return {
        data: graphCreateWriteResult(result.document, acceptedReceipt),
        replayed: result.replayed,
      }
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async dispatchWork(command: GraphWorkCommand) {
      if (command.method === 'claim') {
        const input = command.params
        for (let attempt = 0; attempt < 64; attempt++) {
          const document = await store.read(input.mapId)
          if (!document || document.deletedAt) return { status: 'obsolete' } satisfies GraphClaimResult
          const work = workReadItems(document).find(item => item.workId === input.workId)
          if (!work || document.receipts.some(receipt => receipt.requestId === input.workId)) return { status: 'obsolete' } satisfies GraphClaimResult
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
        if (document.leases[input.workId] && document.receipts.some(receipt => receipt.requestId === input.workId)) {
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
        if (document.receipts.some(receipt => receipt.requestId === failure.workId)) return { failed: false }
        if (!await store.readLease(document.id, failure)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.CANNOT_FAIL_WORK_WITHOUT_ITS_LEASE)
        if (!workReadItems(document).some(work => work.workId === failure.workId)) return { failed: false }
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

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async readData(mapId: string, operationId: string, proof: GraphWorkProof): Promise<GraphDataRead> {
      let document = await graphReadMap(mapId)
      const grant = workReadGrant(document, proof)
      if (grant.operationId !== operationId) throw new GraphError(403, 'WORK_SCOPE_MISMATCH', RuntimeMessage.GRANT_BELONGS_TO_ANOTHER_OPERATION)
      const accepted = document.receipts.some(receipt => receipt.requestId === proof.workId)
      if (!accepted) {
        const leased = await store.readLease(mapId, proof)
        if (!leased) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        document = leased
      }
      const operation = runReadOperation(document.run!, operationId)
      if (operation.kind === 'parse' && operation.rawContent === undefined) {
        if (!options.readSource) throw new GraphError(503, 'SOURCE_UNAVAILABLE', RuntimeMessage.SOURCE_READER_IS_NOT_CONFIGURED)
        const data = runReadData(document, operationId, grant.actor)
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
          status: document.receipts.some(receipt => receipt.requestId === proof.workId) ? 'accepted' : 'ready' },
      }
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async propose(proposal: GraphDataProposal, proof: GraphWorkProof): Promise<GraphSnapshot> {
      const method = `proposal.${proposal.kind}`
      // Independent slot reports may race; retry only the validated database write, never the model.
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
        if (await store.commit(update.document, document.revision, receipt, grant)) {
          return graphReadSnapshot(await graphReadMap(document.id))
        }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_THE_SAME_PROPOSAL_AFTER_CONCURRENT_UPDATES_SETTLE)
    },
  }
}

export type GraphService = ReturnType<typeof graphCreateService>
