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
} from '../contracts/graph'
import { GraphError } from './graph-error'
import {
  runAnswerReview,
  runCancelRun,
  runCreateRun,
  runReadData,
  runUpdateProposal,
  runUpdateReview,
} from './run'
import type { GraphDocument, GraphReceipt, GraphStore } from './store'
import { storeCreateInputHash } from './store'
import { workReadGrant, workReadItems } from './work'

function graphReadSnapshot(document: GraphDocument): GraphSnapshot {
  return {
    mapId: document.id,
    workspaceId: document.workspaceId,
    revision: document.revision,
    name: document.name,
    nodes: document.nodes,
    edges: document.edges,
    run: document.run,
    updatedAt: document.updatedAt,
  }
}

function graphReadReceipt(
  document: GraphDocument,
  requestId: string,
  method: string,
  inputHash: string,
): GraphReceipt | null {
  const receipt = document.receipts.find(item => item.requestId === requestId)
  if (!receipt) return null
  if (receipt.method !== method || receipt.inputHash !== inputHash) {
    throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', 'requestId was already used with different input')
  }
  return receipt
}

function graphCreateWriteResult(document: GraphDocument, receipt: GraphReceipt): GraphWriteResult {
  return {
    snapshot: graphReadSnapshot(document),
    createdNodeIds: receipt.createdNodeIds,
    createdEdgeIds: receipt.createdEdgeIds,
  }
}

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

function graphReadUnique(values: string[], label: string): Set<string> {
  const result = new Set(values)
  if (result.size !== values.length) {
    throw new GraphError(400, 'INVALID_ARGUMENT', `${label} contains duplicate ids`)
  }
  return result
}

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
    throw new GraphError(400, 'INVALID_ARGUMENT', 'A node cannot be put and removed together')
  }
  if (edgePuts.some(item => edgeRemoves.has(item.id))) {
    throw new GraphError(400, 'INVALID_ARGUMENT', 'An edge cannot be put and removed together')
  }
  if (
    changes.name === undefined
    && nodePuts.length === 0
    && nodeRemoves.size === 0
    && edgePuts.length === 0
    && edgeRemoves.size === 0
  ) {
    throw new GraphError(400, 'INVALID_ARGUMENT', 'graph.apply contains no changes')
  }

  const nodes = new Map(document.nodes.map(node => [node.id, node]))
  const edges = new Map(document.edges.map(edge => [edge.id, edge]))
  for (const nodeId of nodeRemoves) {
    if (!nodes.delete(nodeId)) throw new GraphError(404, 'NODE_NOT_FOUND', `Node not found: ${nodeId}`)
    for (const [edgeId, edge] of edges) {
      if (edge.from === nodeId || edge.to === nodeId) edges.delete(edgeId)
    }
  }

  const createdNodeIds: string[] = []
  for (const input of nodePuts) {
    const existing = nodes.get(input.id)
    if (existing && existing.data.kind !== input.data.kind) {
      throw new GraphError(422, 'NODE_KIND_CHANGED', `Node kind cannot change: ${input.id}`)
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
    if (!edges.delete(edgeId)) throw new GraphError(404, 'EDGE_NOT_FOUND', `Edge not found: ${edgeId}`)
  }
  const createdEdgeIds: string[] = []
  for (const input of edgePuts) {
    const from = nodes.get(input.from)
    const to = nodes.get(input.to)
    if (!from || !to) {
      throw new GraphError(422, 'INVALID_RELATION', `Edge references a missing node: ${input.id}`)
    }
    if (input.from === input.to) {
      throw new GraphError(422, 'INVALID_RELATION', `Self edge is not allowed: ${input.id}`)
    }
    if (input.kind === 'mentions' && (from.data.kind !== 'news' || to.data.kind !== 'claim')) {
      throw new GraphError(422, 'INVALID_RELATION', 'mentions must point from news to claim')
    }
    if (input.kind === 'verifies' && (from.data.kind !== 'verification' || to.data.kind !== 'claim')) {
      throw new GraphError(422, 'INVALID_RELATION', 'verifies must point from verification to claim')
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

export function graphCreateService(store: GraphStore, options: { leaseMs?: number } = {}) {
  const leaseMs = options.leaseMs ?? 15_000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000) throw new Error('leaseMs must be between 100 and 300000')
  async function graphReadMap(mapId: string): Promise<GraphDocument> {
    const document = await store.read(mapId)
    if (!document || document.deletedAt) {
      throw new GraphError(404, 'MAP_NOT_FOUND', `Map not found: ${mapId}`)
    }
    return document
  }

  async function graphCommit(
    original: GraphDocument,
    updated: GraphDocument,
    receipt: GraphReceipt,
  ): Promise<{ document: GraphDocument; replayed: boolean }> {
    if (await store.commit(updated, original.revision, receipt)) {
      const committed = await store.read(updated.id)
      if (!committed) throw new Error(`Committed Map disappeared: ${updated.id}`)
      return { document: committed, replayed: false }
    }
    const latest = await store.read(updated.id)
    if (!latest) throw new GraphError(404, 'MAP_NOT_FOUND', `Map not found: ${updated.id}`)
    const replay = graphReadReceipt(latest, receipt.requestId, receipt.method, receipt.inputHash)
    if (replay) return { document: latest, replayed: true }
    throw new GraphError(
      409,
      'REVISION_CONFLICT',
      `Map revision changed: ${updated.id}`,
      latest.revision,
    )
  }

  return {
    async read(query: GraphQuery): Promise<GraphSnapshot | GraphMapSummary[] | GraphRun> {
      if (query.method === 'map.list') return store.list(query.params.workspaceId)
      const document = await graphReadMap(query.params.mapId)
      if (query.method === 'run.get') {
        const run = document.run?.id === query.params.runId ? document.run : document.runHistory.find(run => run.id === query.params.runId)
        if (!run) throw new GraphError(404, 'RUN_NOT_FOUND', 'Run not found')
        return run
      }
      return graphReadSnapshot(document)
    },

    async dispatch(command: GraphCommand, configuration?: GraphRunConfiguration): Promise<{
      data: GraphWriteResult | { mapId: string; deleted: true }
      replayed: boolean
    }> {
      const inputHash = storeCreateInputHash({ method: command.method, params: command.params })
      const now = new Date().toISOString()

      if (command.method === 'map.create') {
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
        if (!document.name) throw new GraphError(400, 'INVALID_ARGUMENT', 'Map name must not be empty')
        if (await store.create(document)) {
          return { data: graphCreateWriteResult(document, receipt), replayed: false }
        }
        const existing = await store.read(document.id)
        if (!existing) throw new Error(`Duplicate Map disappeared: ${document.id}`)
        const replay = graphReadReceipt(existing, command.requestId, command.method, inputHash)
        if (!replay || existing.deletedAt) {
          throw new GraphError(409, 'MAP_EXISTS', `Map already exists: ${document.id}`)
        }
        return { data: graphCreateWriteResult(existing, replay), replayed: true }
      }

      const document = await store.read(command.params.mapId)
      if (!document) throw new GraphError(404, 'MAP_NOT_FOUND', `Map not found: ${command.params.mapId}`)
      const priorReceipt = graphReadReceipt(document, command.requestId, command.method, inputHash)
      if (priorReceipt) {
        if (command.method === 'map.delete') {
          return { data: { mapId: document.id, deleted: true }, replayed: true }
        }
        if (document.deletedAt) throw new GraphError(410, 'MAP_GONE', `Map was deleted: ${document.id}`)
        return { data: graphCreateWriteResult(document, priorReceipt), replayed: true }
      }
      if (document.deletedAt) throw new GraphError(410, 'MAP_GONE', `Map was deleted: ${document.id}`)
      if (document.revision !== command.params.expectedRevision) {
        throw new GraphError(409, 'REVISION_CONFLICT',
          `Expected revision ${command.params.expectedRevision}, found ${document.revision}`, document.revision)
      }

      if (command.method === 'map.delete') {
        if (document.run && ['running', 'waiting'].includes(document.run.status)) {
          throw new GraphError(409, 'RUN_ACTIVE', 'Active run must be cancelled before deleting Map')
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
        if (!configuration) throw new GraphError(422, 'CONFIGURATION_REQUIRED', 'Run requires a resolved Workspace configuration')
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

      if (command.method === 'review.answer') {
        const update = runAnswerReview(structuredClone(document), command.params, now)
        const receipt = graphCreateReceipt(
          command.requestId,
          command.method,
          inputHash,
          now,
          update.nodeId ? [update.nodeId] : [],
          update.edgeId ? [update.edgeId] : [],
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
        throw new GraphError(409, 'RUN_ACTIVE', 'Graph cannot be edited while a run is active')
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
      if (!acceptedReceipt) throw new Error(`Committed receipt disappeared: ${command.requestId}`)
      return {
        data: graphCreateWriteResult(result.document, acceptedReceipt),
        replayed: result.replayed,
      }
    },

    async dispatchWork(command: GraphWorkCommand) {
      if (command.method === 'claim') {
        const input = command.params
        for await (const document of store.discover(input.mapId)) {
          const prior = Object.values(document.leases).find(grant => grant.holderId === input.holderId && grant.hostId === input.hostId)
          if (prior) {
            const current = await store.readLease(document.id, prior)
            if (current) return current.leases[prior.workId]
          }
          for (const work of workReadItems(document)) {
            const grant = await store.claim(document, work, input.hostId, input.holderId, leaseMs)
            if (grant) return grant
          }
        }
        return null
      }
      if (command.method === 'renew') {
        const grant = await store.renew(command.params.mapId, command.params)
        if (!grant) throw new GraphError(409, 'LEASE_LOST', 'Work lease expired, was cancelled or was superseded')
        return grant
      }
      if (command.method === 'read') {
        const input = command.params
        const document = await graphReadMap(input.mapId)
        if (document.leases[input.workId] && document.receipts.some(receipt => receipt.requestId === input.workId)) {
          return { workId: input.workId, status: 'accepted' as const }
        }
        workReadGrant(document, input)
        if (!await store.readLease(input.mapId, input)) throw new GraphError(409, 'LEASE_LOST', 'Work lease is not valid')
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
        if (!await store.readLease(document.id, failure)) throw new GraphError(409, 'LEASE_LOST', 'Cannot fail work without its lease')
        if (!workReadItems(document).some(work => work.workId === failure.workId)) return { failed: false }
        const updated = structuredClone(document)
        updated.run!.status = 'failed'
        updated.run!.operation.status = 'failed'
        updated.run!.error = { code: 'EXECUTION_FAILED', message: failure.message, workId: failure.workId }
        updated.updatedAt = updated.run!.updatedAt = new Date().toISOString()
        const receipt = graphCreateReceipt(failureId, 'work.fail', failureHash, updated.updatedAt)
        if (await store.commit(updated, document.revision, receipt, grant)) return { failed: true }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', 'Retry work failure after concurrent updates settle')
    },

    async readData(mapId: string, operationId: string, proof: GraphWorkProof): Promise<GraphDataRead> {
      let document = await graphReadMap(mapId)
      const grant = workReadGrant(document, proof)
      if (grant.operationId !== operationId) throw new GraphError(403, 'WORK_SCOPE_MISMATCH', 'Grant belongs to another operation')
      const accepted = document.receipts.some(receipt => receipt.requestId === proof.workId)
      if (!accepted) {
        const leased = await store.readLease(mapId, proof)
        if (!leased) throw new GraphError(409, 'LEASE_LOST', 'Work lease is not valid')
        document = leased
      }
      return { ...runReadData(document, operationId, grant.actor),
        work: { id: grant.workId, actor: grant.actor, routeRevision: grant.routeRevision,
          status: document.receipts.some(receipt => receipt.requestId === proof.workId) ? 'accepted' : 'ready' },
      }
    },

    async propose(proposal: GraphDataProposal, proof: GraphWorkProof): Promise<GraphSnapshot> {
      const method = `proposal.${proposal.kind}`
      // Independent slot reports may race; retry only the validated database write, never the model.
      for (let attempt = 0; attempt < 64; attempt++) {
        const document = await graphReadMap(proposal.mapId)
        const grant = document.leases[proof.workId]
        if (!grant) throw new GraphError(409, 'LEASE_LOST', 'Work grant does not exist')
        const actor = grant.actor
        if (proposal.id !== grant.workId || proposal.operationId !== grant.operationId
          || (proposal.kind === 'route' && actor.role !== 'router')
          || (proposal.kind === 'merge' && actor.role !== 'merge')
          || (proposal.kind === 'report' && (actor.role !== 'worker' || actor.slotId !== proposal.slotId))) {
          throw new GraphError(403, 'WORK_SCOPE_MISMATCH', 'Proposal does not belong to this work grant')
        }
        const inputHash = storeCreateInputHash({ proposal, actor })
        const priorReceipt = graphReadReceipt(document, proposal.id, method, inputHash)
        if (priorReceipt) return graphReadSnapshot(document)
        workReadGrant(document, proof)
        if (!await store.readLease(proposal.mapId, proof)) throw new GraphError(409, 'LEASE_LOST', 'Work lease is not valid')
        const view = runReadData(document, proposal.operationId, actor)
        if (view.proposalId !== proposal.id) throw new GraphError(409, 'PROPOSAL_CONFLICT', 'Stale proposal identity')
        const now = new Date().toISOString()
        const update = runUpdateProposal(structuredClone(document), proposal, actor, now)
        const receipt = graphCreateReceipt(proposal.id, method, inputHash, now,
          update.nodeId ? [update.nodeId] : [], update.edgeId ? [update.edgeId] : [])
        if (await store.commit(update.document, document.revision, receipt, grant)) {
          return graphReadSnapshot(await graphReadMap(document.id))
        }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', 'Retry the same proposal after concurrent updates settle')
    },
  }
}

export type GraphService = ReturnType<typeof graphCreateService>
