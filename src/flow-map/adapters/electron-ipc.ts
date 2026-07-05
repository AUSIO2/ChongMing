/**
 * Electron IPC Adapter — 维护每 mapId 一张内存图，翻译 LangGraph 事件与人的 CRUD。
 */
import { AppError, ErrorCode, errReadApp } from '../../../electron/shared/errors'
import type { AddSubAgentInput, MapAPI, MapUpdateReason, UpdateNodeParamsInput } from '../api'
import { MAP_DEFAULT_NEWS_ID, mapIdIsDefaultNews, mapIdIsScopedNews, mapIdUpdateInstance } from '../ids'
import {
  timelineCreateDefault,
  timelineReadEffectiveIndex,
  timelineReadNextStateIndex,
  timelineReadParents,
  timelineReadScope,
  timelineReadScopeAfterParse,
  timelineResolveKeys,
  type MapTimeline,
  type TransitionKey,
} from '../timeline'
import {
  docUpdateError,
  docUpdateInterrupt,
  docUpdateProgress,
  docProjectGraphState,
  docCreateMap,
  docReadResume,
  docCanAddSubAgent as canAddSubAgentPure,
  docCanEditNode as canEditNodePure,
  docCanRemoveNode as canRemoveNodePure,
  docDeleteFocus,
  docCreate,
  docUpdateSubAgent,
  docCreatePersist,
  docUpdateRunEnd,
  docDeleteClaims,
  docDeleteNodes,
  docResetMap,
  docUpdateDraft,
  docReadPersistGraph,
  docReadPersistRun,
  docReadSnapshot,
  docReadInstanceIds,
  docAddSourceChain,
  docAddRootNews,
  docAddRootClaim,
  docReadPendingParseSource,
  type MapGraphDoc,
} from '../graph-doc'
import type {
  MapSubAgentParams,
  Priority,
} from '../types'
import type { ElectronAPI } from '../../../electron/api/types'
import type { DisplayClaim } from '../../../electron/api/types'

type RunOutcome = 'completed' | 'interrupted' | 'error'

function graphListenRunEnd(
  api: ElectronAPI,
  mapId: string,
): { wait: (runId: string) => Promise<RunOutcome>; dispose: () => void } {
  const pending = new Map<string, (outcome: RunOutcome) => void>()

  function settle(runId: string, outcome: RunOutcome) {
    const resolve = pending.get(runId)
    if (!resolve) return
    pending.delete(runId)
    resolve(outcome)
  }

  const offCompleted = api.events.onCompleted((payload) => {
    if (payload.mapId !== mapId) return
    settle(payload.runId, 'completed')
  })
  const offInterrupted = api.events.onInterrupted((payload) => {
    if (payload.mapId !== mapId) return
    settle(payload.runId, 'interrupted')
  })
  const offError = api.events.onError((payload) => {
    if (payload.mapId !== mapId) return
    if (!payload.runId) return
    settle(payload.runId, 'error')
  })

  return {
    wait(runId: string) {
      return new Promise<RunOutcome>((resolve) => {
        pending.set(runId, resolve)
      })
    },
    dispose() {
      offCompleted()
      offInterrupted()
      offError()
      pending.clear()
    },
  }
}

export function adapterBuildIpc(api: ElectronAPI): MapAPI {
  const listeners = new Set<(mapId: string, reason: MapUpdateReason) => void>()
  const graphs = new Map<string, MapGraphDoc>()

  function emitPush(mapId: string, reason: MapUpdateReason) {
    for (const l of listeners) l(mapId, reason)
  }

  function getLoadedDoc(mapId: string): MapGraphDoc | undefined {
    return graphs.get(mapId)
  }

  function getDoc(mapId: string): MapGraphDoc {
    let doc = graphs.get(mapId)
    if (!doc) {
      doc = docCreate(mapId)
      graphs.set(mapId, doc)
    }
    return doc
  }

  async function persistDoc(doc: MapGraphDoc): Promise<void> {
    try {
      const mapGraph = docReadPersistGraph(doc)
      const mapRun = docReadPersistRun(doc)
      if (mapRun) {
        await api.map.saveMapPersistence(doc.mapId, { mapRun, mapGraph })
      } else {
        await api.map.saveMapPersistence(doc.mapId, {
          mapRun: null,
          mapGraph,
        })
      }
    } catch (e) {
      console.error('[map] persist failed', e)
    }
  }

  async function ensureGraph(mapId: string): Promise<MapGraphDoc> {
    const existing = graphs.get(mapId)
    if (existing && existing.nodes.length > 0) return existing

    const map = await api.map.get(mapId)
    if (!map) {
      const doc = docCreate(mapId)
      doc.error = `map not found: ${mapId}`
      graphs.set(mapId, doc)
      return doc
    }

    if (map.mapGraph && Array.isArray(map.mapGraph.nodes) && map.mapGraph.nodes.length > 0) {
      const doc = docCreatePersist(mapId, map.mapGraph, map.mapRun)
      doc.timeline = map.timeline
        ? { ...map.timeline }
        : timelineCreateDefault()
      graphs.set(mapId, doc)

      const run = map.mapRun
      if (run && (run.status === 'interrupted' || run.status === 'running')) {
        doc.runPhase = 'interrupted'
      }

      if (
        run
        && (run.status === 'interrupted' || run.status === 'running')
        && run.gate
        && map.mapGraph.draft
      ) {
        try {
          await api.graph.restore({
            mapId,
            runId: run.runId,
            threadId: run.runId,
            transitionKey: run.transitionKey,
            parentNodeId: run.parentNodeId,
            mode: run.mode,
            gate: run.gate,
            pendingTool: run.pendingTool,
            activeNodeId: run.activeNodeId,
            draft: map.mapGraph.draft,
          })
          doc.runId = run.runId
          doc.threadId = run.runId
        } catch (e) {
          docUpdateError(doc, errReadApp(e).msg)
          doc.runId = undefined
          doc.threadId = undefined
        }
      }
      return doc
    }

    if (existing) return existing

    const doc = docCreateMap(map, 'human-in-loop')
    graphs.set(mapId, doc)
    return doc
  }

  function snapshotOf(mapId: string) {
    return docReadSnapshot(getDoc(mapId))
  }

  async function adapterMutate(
    mapId: string,
    fn: (doc: MapGraphDoc) => void | Promise<void>,
  ): Promise<MapGraphDoc> {
    const doc = await ensureGraph(mapId)
    await fn(doc)
    await persistDoc(doc)
    return doc
  }

  async function runOneTransition(
    doc: MapGraphDoc,
    mapId: string,
    key: TransitionKey,
    parentNodeId: string,
    wait: (runId: string) => Promise<RunOutcome>,
  ): Promise<RunOutcome> {
    doc.error = undefined
    doc.runPhase = 'running'
    doc.draft = undefined
    docDeleteFocus(doc)
    doc.transitionKey = key
    doc.parentNodeId = parentNodeId

    const scopeNodeId = key === '1-2' && parentNodeId !== MAP_DEFAULT_NEWS_ID
      ? parentNodeId
      : undefined

    const { runId } = await api.graph.runTransition({
      mapId,
      transitionKey: key,
      parentNodeId,
      scopeNodeId,
      mode: doc.mode,
    })
    doc.runId = runId
    doc.threadId = runId
    await persistDoc(doc)
    return wait(runId)
  }

  function wireEvents() {
    api.events.onInterrupted((payload) => {
      const mapId = payload.mapId
      const doc = getLoadedDoc(mapId)
      if (!doc) return
      docUpdateInterrupt(doc, payload)
      void persistDoc(doc)
      emitPush(mapId, 'interrupt')
    })

    api.events.onState((payload) => {
      const doc = getLoadedDoc(payload.mapId)
      if (!doc || doc.runId !== payload.runId) return
      if (doc.runPhase === 'error' || doc.runPhase === 'completed') return
      docProjectGraphState(doc, payload.transitionKey, payload.state, {
        completedNode: payload.completedNode,
      })
      void persistDoc(doc)
      emitPush(payload.mapId, 'progress')
    })

    api.events.onCompleted((payload) => {
      const mapId = payload.mapId
      const doc = getLoadedDoc(mapId)
      if (!doc) return
      docUpdateRunEnd(doc)
      void persistDoc(doc).then(() => emitPush(mapId, 'completed'))
    })

    api.events.onError((payload) => {
      const doc = getLoadedDoc(payload.mapId)
      if (!doc) return
      docUpdateError(
        doc,
        payload.failedNode
          ? `[${payload.failedNode}] ${payload.msg}`
          : payload.msg,
      )
      doc.runId = undefined
      doc.threadId = undefined
      void persistDoc(doc)
      emitPush(payload.mapId, 'error')
    })

    api.events.onProgress((payload) => {
      const doc = getLoadedDoc(payload.mapId)
      if (!doc) return
      docUpdateProgress(doc, payload)
      emitPush(payload.mapId, 'progress')
    })
  }

  wireEvents()

  const mapApi: MapAPI = {
    async getSnapshot(mapId) {
      await ensureGraph(mapId)
      return snapshotOf(mapId)
    },

    async getSubAgentCatalog(parentNodeId) {
      const module = mapIdIsDefaultNews(parentNodeId) || mapIdIsScopedNews(parentNodeId)
        ? 'split'
        : 'verify'
      return api.catalog.list(module)
    },

    async addSubAgent(input: AddSubAgentInput) {
      const doc = await adapterMutate(input.mapId, (doc) => {
        const snap = docReadSnapshot(doc)
        if (!canAddSubAgentPure(snap, input.parentNodeId)) {
          throw new AppError(
            ErrorCode.MAP_CANNOT_ADD_SUBAGENT,
            `cannot add SubAgent under ${input.parentNodeId}`,
          )
        }
        const [route] = mapIdUpdateInstance(
          [input.params],
          docReadInstanceIds(doc, input.parentNodeId),
        )
        docUpdateSubAgent(doc, input.parentNodeId, route)
        docUpdateDraft(doc)
      })
      return docReadSnapshot(doc)
    },

    async updateNodeParams(input: UpdateNodeParamsInput) {
      const doc = await adapterMutate(input.mapId, (doc) => {
        const node = doc.nodes.find(n => n.id === input.nodeId)
        if (!node) {
          throw new AppError(
            ErrorCode.MAP_NODE_NOT_FOUND,
            `node not found: ${input.nodeId}`,
          )
        }
        if (!canEditNodePure(docReadSnapshot(doc), input.nodeId)) {
          throw new AppError(
            ErrorCode.MAP_CANNOT_EDIT_NODE,
            `cannot edit ${input.nodeId}`,
          )
        }

        if (node.kind === 'news') {
          const content = (input.params as { content?: string }).content
          if (content !== undefined) {
            node.params = { content }
          }
        } else if (node.kind === 'subAgent') {
          const patch = input.params as Partial<Pick<MapSubAgentParams, 'priority' | 'hint'>>
          node.params = {
            ...node.params,
            priority: (patch.priority ?? node.params.priority) as Priority,
            hint: patch.hint !== undefined ? patch.hint : node.params.hint,
          }
          docUpdateDraft(doc)
        } else if (node.kind === 'claim' && node.dataPhase === 'workerOut') {
          const patch = input.params as { content?: string; category?: string }
          node.params = {
            ...node.params,
            content: patch.content ?? node.params.content,
            category: patch.category !== undefined ? patch.category : node.params.category,
          }
          docUpdateDraft(doc)
        }
      })

      if (doc.nodes.find(n => n.id === input.nodeId)?.kind === 'news') {
        const node = doc.nodes.find(n => n.id === input.nodeId)!
        const content = (input.params as { content?: string }).content
        if (content !== undefined) {
          const scopeNodeId = mapIdIsDefaultNews(node.id) ? undefined : node.id
          await api.map.update(input.mapId, {
            content,
            ...(scopeNodeId ? { scopeNodeId } : {}),
          })
        }
      }

      return docReadSnapshot(doc)
    },

    async removeNode(input) {
      const doc = await adapterMutate(input.mapId, (doc) => {
        const snap = docReadSnapshot(doc)
        if (!canRemoveNodePure(snap, input.nodeId)) {
          throw new AppError(
            ErrorCode.MAP_CANNOT_REMOVE_NODE,
            `cannot remove ${input.nodeId}`,
          )
        }
        docDeleteNodes(doc, new Set([input.nodeId]))
        docUpdateDraft(doc)
      })
      return docReadSnapshot(doc)
    },

    async addSourceChain(mapId, input) {
      const doc = await adapterMutate(mapId, (doc) => {
        docAddSourceChain(doc, input)
      })
      return docReadSnapshot(doc)
    },

    async addRootNews(mapId) {
      const doc = await adapterMutate(mapId, (doc) => {
        docAddRootNews(doc)
      })
      return docReadSnapshot(doc)
    },

    async addRootClaim(mapId) {
      const doc = await adapterMutate(mapId, (doc) => {
        docAddRootClaim(doc)
      })
      return docReadSnapshot(doc)
    },

    async updateTimeline(mapId, patch) {
      await ensureGraph(mapId)
      const map = await api.map.update(mapId, { timeline: patch })
      const doc = getDoc(mapId)
      doc.timeline = map.timeline
      return docReadSnapshot(doc)
    },

    async runTimeline(mapId, mode, selectedNewsId) {
      const listener = graphListenRunEnd(api, mapId)
      try {
        const doc = await ensureGraph(mapId)
        if (mode) doc.mode = mode

        let map = await api.map.get(mapId)
        if (!map) {
          throw new AppError(ErrorCode.MAP_NOT_FOUND, `map not found: ${mapId}`)
        }

        let timeline: MapTimeline = map.timeline
          ? { ...map.timeline }
          : doc.timeline
        doc.timeline = timeline

        let claims: DisplayClaim[] = map.claims

        const readSnap = () => docReadSnapshot(doc)
        let scope = timelineReadScope(readSnap(), timeline, selectedNewsId)
        const effectiveX = timelineReadEffectiveIndex(
          timeline,
          readSnap(),
          claims,
          scope,
        )
        const keys = timelineResolveKeys(timeline, effectiveX)

        for (const key of keys) {
          const parents = timelineReadParents(readSnap(), key, scope, claims)
          if (parents.length === 0) continue

          for (const parentId of parents) {
            const outcome = await runOneTransition(doc, mapId, key, parentId, listener.wait)
            if (outcome === 'interrupted') {
              return {
                runId: doc.runId!,
                snapshot: readSnap(),
                status: 'interrupted' as const,
              }
            }
            if (outcome === 'error') {
              throw new AppError(ErrorCode.MAP_SCOPE_NOT_FOUND, `transition ${key} failed`)
            }

            map = await api.map.get(mapId)
            if (map) claims = map.claims

            if (key === '0-1') {
              const nextScope = timelineReadScopeAfterParse(parentId)
              if (nextScope) {
                scope = nextScope
                timeline = { ...timeline, activeScope: nextScope }
                doc.timeline = timeline
                const updated = await api.map.update(mapId, {
                  timeline: { activeScope: nextScope },
                })
                timeline = updated.timeline
                doc.timeline = timeline
              }
            }
          }

          const nextIdx = timelineReadNextStateIndex(key)
          timeline = { ...timeline, stateIndex: nextIdx }
          doc.timeline = timeline
          const updated = await api.map.update(mapId, { timeline: { stateIndex: nextIdx } })
          timeline = updated.timeline
          doc.timeline = timeline
        }

        docUpdateRunEnd(doc)
        await persistDoc(doc)
        return {
          runId: doc.runId ?? '',
          snapshot: readSnap(),
          status: 'done' as const,
        }
      } catch (e) {
        const doc = getDoc(mapId)
        docUpdateError(doc, errReadApp(e).msg)
        doc.runId = undefined
        doc.threadId = undefined
        await persistDoc(doc)
        throw e
      } finally {
        listener.dispose()
      }
    },

    async startParse(mapId, sourceId) {
      try {
        const doc = await adapterMutate(mapId, async (doc) => {
          const parentNodeId = sourceId ?? docReadPendingParseSource(doc)
          if (!parentNodeId) {
            throw new AppError(
              ErrorCode.MAP_SCOPE_NOT_FOUND,
              'no pending source to parse',
            )
          }
          doc.error = undefined
          doc.runPhase = 'running'
          doc.draft = undefined
          docDeleteFocus(doc)
          doc.transitionKey = '0-1'
          doc.parentNodeId = parentNodeId

          const { runId } = await api.graph.runTransition({
            mapId,
            transitionKey: '0-1',
            parentNodeId,
            mode: doc.mode,
          })
          doc.runId = runId
          doc.threadId = runId
        })
        return { runId: doc.runId!, snapshot: docReadSnapshot(doc) }
      } catch (e) {
        const doc = getDoc(mapId)
        docUpdateError(doc, errReadApp(e).msg)
        doc.runId = undefined
        doc.threadId = undefined
        await persistDoc(doc)
        throw e
      }
    },

    async startRun(mapId, mode) {
      try {
        const doc = await adapterMutate(mapId, async (doc) => {
          if (mode) doc.mode = mode
          doc.error = undefined
          doc.runPhase = 'running'
          doc.draft = undefined
          docDeleteFocus(doc)

          const scopedNews = doc.nodes.find(
            n => n.kind === 'news' && n.id !== MAP_DEFAULT_NEWS_ID && n.params.content.trim(),
          )
          if (scopedNews) {
            doc.transitionKey = '1-2'
            doc.parentNodeId = scopedNews.id
          } else {
            const newsNode = doc.nodes.find(
              (n): n is import('../types').MapNewsNode =>
                n.id === MAP_DEFAULT_NEWS_ID && n.kind === 'news',
            )
            doc.nodes = newsNode ? [newsNode] : []
            doc.edges = []
            doc.transitionKey = '1-2'
            doc.parentNodeId = MAP_DEFAULT_NEWS_ID
          }

          const { runId } = await api.graph.runTransition({
            mapId,
            transitionKey: '1-2',
            parentNodeId: doc.parentNodeId!,
            mode: doc.mode,
          })
          doc.runId = runId
          doc.threadId = runId
        })
        return { runId: doc.runId!, snapshot: docReadSnapshot(doc) }
      } catch (e) {
        const doc = getDoc(mapId)
        docUpdateError(doc, errReadApp(e).msg)
        doc.runId = undefined
        doc.threadId = undefined
        await persistDoc(doc)
        throw e
      }
    },

    async continueStep(mapId) {
      const doc = getDoc(mapId)
      if (!doc.runId) {
        await ensureGraph(mapId)
        return snapshotOf(mapId)
      }
      if (doc.runPhase === 'running' && !doc.pendingTool) {
        return snapshotOf(mapId)
      }

      if (doc.pendingTool === 'validate') {
        docDeleteClaims(doc)
      }
      docUpdateDraft(doc)
      const modifications = docReadResume(doc)

      const prevPhase = doc.runPhase
      const prevActiveNodeId = doc.activeNodeId
      const prevPendingTool = doc.pendingTool

      doc.runPhase = 'running'
      docDeleteFocus(doc)
      await persistDoc(doc)
      try {
        await api.graph.resume(doc.runId!, modifications)
      } catch (e) {
        doc.runPhase = prevPhase
        doc.activeNodeId = prevActiveNodeId
        doc.pendingTool = prevPendingTool
        await persistDoc(doc)
        throw e
      }
      return snapshotOf(mapId)
    },

    async cancel(mapId) {
      const doc = getDoc(mapId)
      if (doc.runId) await api.graph.cancel(doc.runId)
      const map = await api.map.get(mapId)
      if (map) {
        docResetMap(doc, map)
      } else {
        graphs.set(mapId, docCreate(mapId))
      }
      await persistDoc(getDoc(mapId))
      return snapshotOf(mapId)
    },

    async setMode(mapId, mode) {
      const doc = await adapterMutate(mapId, async (doc) => {
        doc.mode = mode
        if (doc.runId) await api.graph.setMode(doc.runId, mode)
      })
      return docReadSnapshot(doc)
    },

    unloadMap(mapId) {
      graphs.delete(mapId)
    },

    onUpdated(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }

  return mapApi
}
