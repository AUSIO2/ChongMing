import {
  MAP_DEFAULT_NEWS_ID,
  mapIdCreateChain,
  mapIdCreateClaim,
  mapIdCreateNews,
  mapIdCreateRoute,
  mapIdCreateSource,
  mapIdReadChain,
  mapIdUpdateInstance,
} from '../shared/map-ids'
import { randomUUID } from 'node:crypto'
import { AppError, ErrorCode } from '../shared/errors'
import { mapLeaseRelease, mapLeaseTryAcquire } from '../api/map-lease'
import {
  mapDocumentCommit,
  mapDocumentCreate,
  mapDocumentDelete,
  mapDocumentList,
  mapDocumentRead,
} from './document'
import { projectSnapshot } from './project'
import { parseStep } from './stages/parse'
import { splitStep } from './stages/split'
import { verifyStep } from './stages/verify'
import type {
  AgentLoop,
  MapperAPI,
  MapperCommand,
  MapperCallPlan,
  MapperCallRecord,
  MapperDispatchResult,
  MapperDocument,
  MapperNodeCreate,
  MapperNodePatch,
  MapperUpdated,
} from './types'

async function requireDocument(mapId: string): Promise<MapperDocument> {
  const document = await mapDocumentRead(mapId)
  if (!document) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
  return document
}

function applyNodeCreate(document: MapperDocument, node: MapperNodeCreate): void {
  if (node.kind === 'source') {
    const chainId = mapIdCreateChain()
    document.sources.push({
      id: mapIdCreateSource(chainId),
      uri: node.uri,
      kind: node.sourceKind,
      label: node.label,
    })
    return
  }

  if (node.kind === 'news') {
    const id = node.sourceId
      ? mapIdCreateNews(mapIdReadChain(node.sourceId) ?? '')
      : MAP_DEFAULT_NEWS_ID
    if (!id || document.news.some(news => news.id === id)) {
      throw new AppError(ErrorCode.MAP_CANNOT_EDIT_NODE, `News already exists: ${id}`)
    }
    if (node.sourceId && !document.sources.some(source => source.id === node.sourceId)) {
      throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `Source not found: ${node.sourceId}`)
    }
    document.news.push({
      id,
      sourceId: node.sourceId,
      content: node.content,
      context: node.context ?? {},
    })
    if (!document.timeline.activeScope) document.timeline.activeScope = id
    return
  }

  if (node.kind === 'claim') {
    if (node.newsId && !document.news.some(news => news.id === node.newsId)) {
      throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `News not found: ${node.newsId}`)
    }
    const index = document.claims.filter(claim => claim.newsId === node.newsId).length
    document.claims.push({
      id: mapIdCreateClaim(index, node.newsId),
      newsId: node.newsId,
      content: node.content,
      category: node.category,
      sourceAgent: node.sourceAgent,
    })
    return
  }

  const parentExists = document.news.some(news => news.id === node.parentId)
    || document.claims.some(claim => claim.id === node.parentId)
  if (!parentExists) {
    throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `Route parent not found: ${node.parentId}`)
  }
  const [route] = mapIdUpdateInstance(
    [node],
    document.routes
      .filter(route => route.parentId === node.parentId)
      .map(route => ({ instanceId: route.instanceId })),
  )
  document.routes.push({ ...route, parentId: node.parentId })
}

function applyNodeUpdate(
  document: MapperDocument,
  nodeId: string,
  patch: MapperNodePatch,
): void {
  if (patch.kind === 'source') {
    const source = document.sources.find(item => item.id === nodeId)
    if (!source) throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `Source not found: ${nodeId}`)
    if (patch.uri !== undefined) source.uri = patch.uri
    if (patch.sourceKind !== undefined) source.kind = patch.sourceKind
    if (patch.label !== undefined) source.label = patch.label
    return
  }
  if (patch.kind === 'news') {
    const news = document.news.find(item => item.id === nodeId)
    if (!news) throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `News not found: ${nodeId}`)
    if (patch.content !== undefined) news.content = patch.content
    if (patch.context !== undefined) news.context = patch.context
    return
  }
  if (patch.kind === 'claim') {
    const claim = document.claims.find(item => item.id === nodeId)
    if (!claim) throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `Claim not found: ${nodeId}`)
    if (patch.content !== undefined) claim.content = patch.content
    if (patch.category !== undefined) claim.category = patch.category
    if (patch.sourceAgent !== undefined) claim.sourceAgent = patch.sourceAgent
    return
  }
  const route = document.routes.find(
    item => mapIdCreateRoute(item, item.parentId) === nodeId,
  )
  if (!route) throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `Route not found: ${nodeId}`)
  if (patch.priority !== undefined) route.priority = patch.priority
  if (patch.hint !== undefined) route.hint = patch.hint
}

function applyNodeDelete(document: MapperDocument, nodeId: string): void {
  const source = document.sources.find(item => item.id === nodeId)
  const deletedNews = new Set(
    source
      ? document.news.filter(news => news.sourceId === nodeId).map(news => news.id)
      : document.news.some(news => news.id === nodeId) ? [nodeId] : [],
  )
  const claim = document.claims.find(item => item.id === nodeId)
  const route = document.routes.find(
    item => mapIdCreateRoute(item, item.parentId) === nodeId,
  )

  if (!source && deletedNews.size === 0 && !claim && !route) {
    throw new AppError(ErrorCode.MAP_NODE_NOT_FOUND, `Node not found: ${nodeId}`)
  }

  const deletedClaims = new Set([
    ...(claim ? [claim.id] : []),
    ...document.claims
      .filter(item => item.newsId && deletedNews.has(item.newsId))
      .map(item => item.id),
  ])

  if (source) document.sources = document.sources.filter(item => item.id !== nodeId)
  if (deletedNews.size > 0) {
    document.news = document.news.filter(news => !deletedNews.has(news.id))
    document.claims = document.claims.filter(item => !item.newsId || !deletedNews.has(item.newsId))
  }
  if (claim) document.claims = document.claims.filter(item => item.id !== nodeId)

  if (route) {
    if (document.news.some(news => news.id === route.parentId)) {
      document.claims = document.claims.filter(item =>
        item.newsId !== route.parentId || item.sourceInstanceId !== route.instanceId)
    } else {
      const owner = document.claims.find(item => item.id === route.parentId)
      if (owner?.verify) {
        owner.verify.opinions = owner.verify.opinions.filter(
          opinion => opinion.instanceId !== route.instanceId,
        )
      }
    }
  }

  document.routes = document.routes.filter(item =>
    mapIdCreateRoute(item, item.parentId) !== nodeId
    && !deletedNews.has(item.parentId)
    && !deletedClaims.has(item.parentId),
  )
  if (deletedNews.has(document.timeline.activeScope)) {
    document.timeline.activeScope = ''
  }
}

export function createMapper(agentLoop: AgentLoop): MapperAPI & { close(): Promise<void> } {
  const listeners = new Set<(event: MapperUpdated) => void>()
  const tails = new Map<string, Promise<unknown>>()
  const activeRuns = new Map<string, AbortController>()

  function emit(document: MapperDocument): void {
    const event = { mapId: document.id, snapshot: projectSnapshot(document) }
    for (const listener of listeners) listener(event)
  }

  function enqueue<T>(mapId: string, operation: () => Promise<T>): Promise<T> {
    const next = (tails.get(mapId) ?? Promise.resolve()).then(operation)
    tails.set(mapId, next.then(() => undefined, () => undefined))
    return next
  }

  async function commit(document: MapperDocument): Promise<MapperDocument> {
    const committed = await mapDocumentCommit(document, document.revision)
    emit(committed)
    return committed
  }

  async function runUntilPause(
    initial: MapperDocument,
    controller: AbortController,
    skipGate = false,
  ): Promise<MapperDocument> {
    let document = initial
    let checkpointTail = Promise.resolve()

    async function checkpoint(
      callId: string,
      update: (record: MapperCallRecord) => void,
    ): Promise<void> {
      checkpointTail = checkpointTail.then(async () => {
        const record = document.run?.draft.calls.find(item => item.call.callId === callId)
        if (!record) {
          throw new AppError(ErrorCode.MAPPER_EXECUTION_FAILED, `Call not found: ${callId}`)
        }
        update(record)
        Object.assign(document, await commit(document))
      })
      await checkpointTail
    }

    async function executeCalls(plans: MapperCallPlan[]): Promise<MapperCallRecord[]> {
      const run = document.run!
      const now = new Date().toISOString()
      let planned = false
      for (const plan of plans) {
        if (run.draft.calls.some(record => record.call.callId === plan.call.callId)) continue
        run.draft.calls.push({
          ...plan,
          status: 'pending',
          attempt: 0,
          plannedAt: now,
        })
        planned = true
      }
      if (planned) Object.assign(document, await commit(document))

      const ids = plans.map(plan => plan.call.callId)
      const pending = document.run!.draft.calls.filter(record =>
        ids.includes(record.call.callId) && record.status === 'pending')
      if (pending.length > 0) {
        const startedAt = new Date().toISOString()
        for (const record of pending) {
          record.status = 'running'
          record.attempt += 1
          record.startedAt = startedAt
          record.error = undefined
        }
        Object.assign(document, await commit(document))
      }

      const runningIds = document.run!.draft.calls
        .filter(record => ids.includes(record.call.callId) && record.status === 'running')
        .map(record => record.call.callId)
      const settled = await Promise.allSettled(runningIds.map(async (callId) => {
        const record = document.run!.draft.calls.find(item => item.call.callId === callId)!
        try {
          const result = await agentLoop.run(record.call, {
            signal: controller.signal,
            onEvent: () => {},
          })
          await checkpoint(callId, current => {
            current.status = 'completed'
            current.result = result
            current.completedAt = new Date().toISOString()
          })
        } catch (error) {
          await checkpoint(callId, current => {
            current.status = controller.signal.aborted ? 'cancelled' : 'failed'
            current.error = error instanceof Error ? error.message : String(error)
            current.completedAt = new Date().toISOString()
          })
          throw error
        }
      }))
      const failed = settled.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason

      return ids.map(callId => {
        const record = document.run!.draft.calls.find(item => item.call.callId === callId)!
        if (record.status !== 'completed') {
          throw new AppError(ErrorCode.MAPPER_EXECUTION_FAILED, `Call incomplete: ${callId}`)
        }
        return record
      })
    }

    try {
      while (document.run) {
        const run = document.run
        const atGate = run.step === 'confirm-route'
          || run.step === 'validate'
          || run.step === 'save'
        if (atGate && run.mode === 'human-in-loop' && !skipGate) {
          run.status = 'interrupted'
          run.pauseReason = 'human'
          run.updatedAt = new Date().toISOString()
          return commit(document)
        }
        skipGate = false
        run.status = 'running'
        run.pauseReason = undefined
        const step = run.stage === 'parse'
          ? parseStep
          : run.stage === 'split' ? splitStep : verifyStep
        await step({ document, signal: controller.signal, executeCalls })
        const currentRun = document.run!
        currentRun.updatedAt = new Date().toISOString()
        if (currentRun.step === 'done') document.run = undefined
        document = await commit(document)
      }
      return document
    } catch (error) {
      if (document.run) {
        document.run.status = controller.signal.aborted ? 'cancelled' : 'error'
        document.run.pauseReason = controller.signal.aborted ? undefined : 'call-failed'
        document.run.error = error instanceof Error ? error.message : String(error)
        document.run.updatedAt = new Date().toISOString()
        document = await commit(document)
      }
      if (!controller.signal.aborted) throw error
      return document
    }
  }

  function readNextRun(
    document: MapperDocument,
    selectedNodeId?: string,
  ): { stage: 'parse' | 'split' | 'verify'; targetId: string } {
    const source = document.timeline.endX > 0
      ? document.sources.find(item => {
      if (selectedNodeId && item.id !== selectedNodeId) return false
      const chainId = mapIdReadChain(item.id)
      return Boolean(chainId && !document.news.some(
        news => news.id === mapIdCreateNews(chainId),
      ))
        })
      : undefined
    if (source) return { stage: 'parse', targetId: source.id }

    const news = document.timeline.endX > 1
      ? document.news.find(item =>
        (!selectedNodeId || item.id === selectedNodeId)
        && !document.claims.some(claim => claim.newsId === item.id),
      )
      : undefined
    if (news) return { stage: 'split', targetId: news.id }

    const claim = document.timeline.endX > 2
      ? document.claims.find(item =>
        (!selectedNodeId || item.id === selectedNodeId || item.newsId === selectedNodeId)
        && !item.verify,
      )
      : undefined
    if (claim) return { stage: 'verify', targetId: claim.id }

    throw new AppError(ErrorCode.MAP_SCOPE_NOT_FOUND, 'No pending Mapper work')
  }

  async function update(
    command: Exclude<MapperCommand, { type: 'map.create' | 'run.cancel' }>,
  ): Promise<MapperDispatchResult> {
    if (command.type === 'map.delete') {
      await mapDocumentDelete(command.mapId)
      return { type: 'map.deleted', mapId: command.mapId }
    }
    if (command.type === 'lease.acquire') {
      const result = await mapLeaseTryAcquire(command.mapId)
      if (result.ok && !activeRuns.has(command.mapId)) {
        const document = await requireDocument(command.mapId)
        if (document.run?.status === 'running') {
          document.run.status = 'interrupted'
          document.run.pauseReason = 'restart'
          document.run.error = undefined
          for (const call of document.run.draft.calls) {
            if (call.status === 'running') call.status = 'pending'
          }
          await commit(document)
        }
      }
      return { type: 'lease.updated', mapId: command.mapId, ...result }
    }
    if (command.type === 'lease.release') {
      await mapLeaseRelease(command.mapId)
      return {
        type: 'lease.updated',
        mapId: command.mapId,
        ok: true,
        lease: null,
      }
    }

    let document = await requireDocument(command.mapId)
    if (command.type === 'run.start') {
      if (document.run) {
        throw new AppError(ErrorCode.MAPPER_EXECUTION_FAILED, 'Map run already active')
      }
      let selectedNodeId = command.selectedNodeId
      let ran = false
      while (true) {
        let next: ReturnType<typeof readNextRun>
        try {
          next = readNextRun(document, selectedNodeId)
        } catch (error) {
          if (ran && error instanceof AppError && error.code === ErrorCode.MAP_SCOPE_NOT_FOUND) {
            break
          }
          throw error
        }
        ran = true
        selectedNodeId = undefined
        document.run = {
          runId: randomUUID(),
          stage: next.stage,
          step: 'load',
          status: 'running',
          mode: command.mode,
          targetId: next.targetId,
          draft: { routes: [], calls: [], saveIndex: 0 },
          updatedAt: new Date().toISOString(),
        }
        document = await commit(document)
        const controller = new AbortController()
        activeRuns.set(command.mapId, controller)
        try {
          document = await runUntilPause(document, controller)
        } finally {
          activeRuns.delete(command.mapId)
        }
        if (command.mode !== 'auto' || document.run) break
      }
      return { type: 'map.updated', snapshot: projectSnapshot(document) }
    }
    if (command.type === 'run.continue') {
      if (!document.run || !['interrupted', 'error'].includes(document.run.status)) {
        throw new AppError(ErrorCode.MAPPER_RUN_NOT_FOUND, 'Map run cannot continue')
      }
      const skipGate = document.run.pauseReason === 'human'
      if (command.decision?.output !== undefined) {
        document.run.draft.output = command.decision.output
      }
      if (command.decision?.routes !== undefined) {
        document.run.draft.routes = command.decision.routes
      }
      if (command.decision?.claims !== undefined) {
        document.run.draft.claims = command.decision.claims
      }
      if (command.decision?.opinions !== undefined) {
        document.run.draft.opinions = command.decision.opinions
      }
      if (command.decision?.verify !== undefined) {
        document.run.draft.verify = command.decision.verify
      }
      if (command.decision?.mode !== undefined) {
        document.run.mode = command.decision.mode
      }
      document.run.status = 'running'
      document.run.pauseReason = undefined
      document.run.error = undefined
      for (const call of document.run.draft.calls) {
        if (call.status === 'failed') call.status = 'pending'
      }
      document = await commit(document)
      const controller = new AbortController()
      activeRuns.set(command.mapId, controller)
      try {
        document = await runUntilPause(document, controller, skipGate)
      } finally {
        activeRuns.delete(command.mapId)
      }
      return { type: 'map.updated', snapshot: projectSnapshot(document) }
    }
    if (command.type === 'run.set-mode') {
      if (!document.run) {
        throw new AppError(ErrorCode.MAPPER_RUN_NOT_FOUND, 'Map run not found')
      }
      document.run.mode = command.mode
      const shouldContinue = command.mode === 'auto'
        && document.run.status === 'interrupted'
      document.run.status = shouldContinue ? 'running' : document.run.status
      document = await commit(document)
      if (shouldContinue) {
        const controller = new AbortController()
        activeRuns.set(command.mapId, controller)
        try {
          document = await runUntilPause(document, controller, true)
        } finally {
          activeRuns.delete(command.mapId)
        }
      }
      return { type: 'map.updated', snapshot: projectSnapshot(document) }
    }
    if (command.type === 'claims.dedup') {
      const seen = new Set<string>()
      document.claims = document.claims.filter(claim => {
        const key = [
          claim.newsId ?? '',
          claim.sourceInstanceId ?? '',
          claim.content.trim().toLowerCase(),
          (claim.category ?? '').trim().toLowerCase(),
        ].join('|')
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const committed = await commit(document)
      return { type: 'map.updated', snapshot: projectSnapshot(committed) }
    }
    if (command.type === 'routes.batch-update') {
      for (const route of document.routes) {
        if (command.patch.parentId && route.parentId !== command.patch.parentId) continue
        if (command.patch.agentName && route.agentName !== command.patch.agentName) continue
        if (command.patch.priority !== undefined) route.priority = command.patch.priority
        if (command.patch.hint !== undefined) route.hint = command.patch.hint
      }
      const committed = await commit(document)
      return { type: 'map.updated', snapshot: projectSnapshot(committed) }
    }

    const revision = document.revision
    if (command.type === 'map.rename') {
      document.name = command.name.trim() || undefined
    } else if (command.type === 'node.create') {
      applyNodeCreate(document, command.node)
    } else if (command.type === 'node.update') {
      applyNodeUpdate(document, command.nodeId, command.patch)
    } else if (command.type === 'node.delete') {
      applyNodeDelete(document, command.nodeId)
    } else {
      const timeline = { ...document.timeline, ...command.patch }
      if (timeline.startX > timeline.endX) {
        throw new AppError(
          ErrorCode.MAP_CANNOT_EDIT_NODE,
          `timeline startX ${timeline.startX} > endX ${timeline.endX}`,
        )
      }
      document.timeline = timeline
    }
    const committed = await mapDocumentCommit(document, revision)
    emit(committed)
    return { type: 'map.updated', snapshot: projectSnapshot(committed) }
  }

  return {
    async read(query) {
      if (query.type === 'map.list') {
        return { type: query.type, maps: await mapDocumentList(query.workspaceId) }
      }
      const document = await mapDocumentRead(query.mapId)
      return {
        type: query.type,
        snapshot: document ? projectSnapshot(document) : null,
      }
    },

    async dispatch(command) {
      if (command.type === 'map.create') {
        const document = await mapDocumentCreate(command)
        emit(document)
        return { type: 'map.updated', snapshot: projectSnapshot(document) }
      }
      if (command.type === 'run.cancel') {
        activeRuns.get(command.mapId)?.abort(new Error('Run cancelled'))
        let document = await requireDocument(command.mapId)
        if (document.run && !activeRuns.has(command.mapId)) {
          document.run.status = 'cancelled'
          document.run.error = 'Run cancelled'
          document = await commit(document)
        }
        return { type: 'map.updated', snapshot: projectSnapshot(document) }
      }
      return enqueue(command.mapId, () => update(command))
    },

    watch(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    close() {
      for (const controller of activeRuns.values()) controller.abort()
      return agentLoop.close()
    },
  }
}
