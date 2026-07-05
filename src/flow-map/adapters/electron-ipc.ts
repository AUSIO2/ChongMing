/**
 * Electron IPC Adapter — 维护每新闻一张内存图，翻译 LangGraph 事件与人的 CRUD。
 */
import { AppError, ErrorCode, errReadApp } from '../../../electron/shared/errors'
import type { AddSubAgentInput, MapAPI, MapUpdateReason, UpdateNodeParamsInput } from '../api'
import { NEWS_ROOT_ID, mapIdUpdateInstance } from '../ids'
import {
  docUpdateError,
  docUpdateInterrupt,
  docUpdateProgress,
  docProjectGraphState,
  docCreateNews,
  docReadResume,
  docCanAddSubAgent as canAddSubAgentPure,
  docCanEditNode as canEditNodePure,
  docCanRemoveNode as canRemoveNodePure,
  docDeleteFocus,
  docCreate,
  docUpdateSubAgent,
  docCreatePersist,
  docUpdateRunEnd,
  docUpdateVerify,
  docDeleteClaims,
  docDeleteNodes,
  docResetNews,
  docUpdateDraft,
  docReadPersistGraph,
  docReadPersistRun,
  docReadSnapshot,
  docReadInstanceIds,
  type MapGraphDoc,
} from '../graph-doc'
import type {
  MapSubAgentParams,
  Priority,
} from '../types'
import type { ElectronAPI } from '../../../electron/api/types'

export function adapterBuildIpc(api: ElectronAPI): MapAPI {
  const listeners = new Set<(newsId: string, reason: MapUpdateReason) => void>()
  const graphs = new Map<string, MapGraphDoc>()

  function emitPush(newsId: string, reason: MapUpdateReason) {
    for (const l of listeners) l(newsId, reason)
  }

  function getLoadedDoc(newsId: string): MapGraphDoc | undefined {
    return graphs.get(newsId)
  }

  function getDoc(newsId: string): MapGraphDoc {
    let doc = graphs.get(newsId)
    if (!doc) {
      doc = docCreate(newsId)
      graphs.set(newsId, doc)
    }
    return doc
  }

  async function persistDoc(doc: MapGraphDoc): Promise<void> {
    try {
      const mapGraph = docReadPersistGraph(doc)
      const mapRun = docReadPersistRun(doc)
      if (mapRun) {
        await api.news.saveMapPersistence(doc.newsId, { mapRun, mapGraph })
      } else {
        await api.news.saveMapPersistence(doc.newsId, {
          mapRun: null,
          mapGraph,
        })
      }
    } catch (e) {
      console.error('[map] persist failed', e)
    }
  }

  async function ensureGraph(newsId: string): Promise<MapGraphDoc> {
    const existing = graphs.get(newsId)
    if (existing && existing.nodes.length > 0) return existing

    const news = await api.news.get(newsId)
    if (!news) {
      const doc = docCreate(newsId)
      doc.error = `news not found: ${newsId}`
      graphs.set(newsId, doc)
      return doc
    }

    if (news.mapGraph && Array.isArray(news.mapGraph.nodes) && news.mapGraph.nodes.length > 0) {
      const doc = docCreatePersist(newsId, news.mapGraph, news.mapRun)
      graphs.set(newsId, doc)

      const run = news.mapRun
      if (run && (run.status === 'interrupted' || run.status === 'running')) {
        doc.runPhase = 'interrupted'
      }

      if (
        run
        && (run.status === 'interrupted' || run.status === 'running')
        && run.gate
        && news.mapGraph.draft
      ) {
        try {
          await api.graph.restore({
            newsId,
            runId: run.runId,
            threadId: run.runId,
            graphType: run.graphType,
            mode: run.mode,
            gate: run.gate,
            pendingTool: run.pendingTool,
            activeNodeId: run.activeNodeId,
            claimId: run.claimId,
            draft: news.mapGraph.draft,
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

    const doc = docCreateNews(news, existing?.mode ?? 'human-in-loop')
    graphs.set(newsId, doc)
    return doc
  }

  function snapshotOf(newsId: string) {
    return docReadSnapshot(getDoc(newsId))
  }

  async function adapterMutate(
    newsId: string,
    fn: (doc: MapGraphDoc) => void | Promise<void>,
  ): Promise<MapGraphDoc> {
    const doc = await ensureGraph(newsId)
    await fn(doc)
    await persistDoc(doc)
    return doc
  }

  async function startNextVerify(newsId: string): Promise<void> {
    const doc = getDoc(newsId)
    doc.runId = undefined
    doc.threadId = undefined
    const news = await api.news.get(newsId)
    if (!news) return

    const next = news.claims.find(c => !c.verifyResult)
    if (!next) {
      docUpdateRunEnd(doc)
      await persistDoc(doc)
      return
    }

    docUpdateVerify(doc)
    doc.graphType = 'verify'

    const { runId } = await api.graph.startVerify({
      newsId,
      claimId: next.claimId,
      mode: doc.mode,
    })
    doc.runId = runId
    doc.threadId = runId
    await persistDoc(doc)
  }

  function wireEvents() {
    api.events.onInterrupted((payload) => {
      const newsId = payload.state.newsId
      const doc = getLoadedDoc(newsId)
      if (!doc) return
      docUpdateInterrupt(doc, payload)
      void persistDoc(doc)
      emitPush(newsId, 'interrupt')
    })

    api.events.onState((payload) => {
      const doc = getLoadedDoc(payload.newsId)
      if (!doc || doc.runId !== payload.runId) return
      if (doc.runPhase === 'error' || doc.runPhase === 'completed') return
      docProjectGraphState(doc, payload.graphType, payload.state, {
        completedNode: payload.completedNode,
      })
      void persistDoc(doc)
      emitPush(payload.newsId, 'progress')
    })

    api.events.onCompleted((payload) => {
      const newsId = payload.state.newsId
      const doc = getLoadedDoc(newsId)
      if (!doc) return
      doc.runId = undefined
      doc.threadId = undefined
      void (async () => {
        try {
          await startNextVerify(newsId)
        } catch (e) {
          docUpdateError(doc, errReadApp(e).msg)
          await persistDoc(doc)
        }
        emitPush(newsId, 'completed')
      })()
    })

    api.events.onError((payload) => {
      const doc = getLoadedDoc(payload.newsId)
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
      emitPush(payload.newsId, 'error')
    })

    api.events.onProgress((payload) => {
      const doc = getLoadedDoc(payload.newsId)
      if (!doc) return
      docUpdateProgress(doc, payload)
      emitPush(payload.newsId, 'progress')
    })
  }

  wireEvents()

  const mapApi: MapAPI = {
    async getSnapshot(newsId) {
      await ensureGraph(newsId)
      return snapshotOf(newsId)
    },

    async getSubAgentCatalog(parentNodeId) {
      const module = parentNodeId === NEWS_ROOT_ID ? 'split' : 'verify'
      return api.catalog.list(module)
    },

    async addSubAgent(input: AddSubAgentInput) {
      const doc = await adapterMutate(input.newsId, (doc) => {
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
      const doc = await adapterMutate(input.newsId, (doc) => {
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
        const content = (input.params as { content?: string }).content
        if (content !== undefined) {
          await api.news.update(input.newsId, { content })
        }
      }

      return docReadSnapshot(doc)
    },

    async removeNode(input) {
      const doc = await adapterMutate(input.newsId, (doc) => {
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

    async startRun(newsId, mode) {
      try {
        const doc = await adapterMutate(newsId, async (doc) => {
          if (mode) doc.mode = mode
          doc.error = undefined
          doc.runPhase = 'running'
          doc.draft = undefined
          docDeleteFocus(doc)
          const newsNode = doc.nodes.find(n => n.kind === 'news')
          doc.nodes = newsNode ? [newsNode] : []
          doc.edges = []

          const { runId } = await api.graph.startSplit({
            newsId,
            mode: doc.mode,
          })
          doc.runId = runId
          doc.threadId = runId
          doc.graphType = 'split'
        })
        return { runId: doc.runId!, snapshot: docReadSnapshot(doc) }
      } catch (e) {
        const doc = getDoc(newsId)
        docUpdateError(doc, errReadApp(e).msg)
        doc.runId = undefined
        doc.threadId = undefined
        await persistDoc(doc)
        throw e
      }
    },

    async continueStep(newsId) {
      const doc = getDoc(newsId)
      if (!doc.runId) {
        await ensureGraph(newsId)
        return snapshotOf(newsId)
      }
      if (doc.runPhase === 'running' && !doc.pendingTool) {
        return snapshotOf(newsId)
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
      return snapshotOf(newsId)
    },

    async cancel(newsId) {
      const doc = getDoc(newsId)
      if (doc.runId) await api.graph.cancel(doc.runId)
      const news = await api.news.get(newsId)
      if (news) {
        docResetNews(doc, news)
      } else {
        graphs.set(newsId, docCreate(newsId))
      }
      await persistDoc(getDoc(newsId))
      return snapshotOf(newsId)
    },

    async setMode(newsId, mode) {
      const doc = await adapterMutate(newsId, async (doc) => {
        doc.mode = mode
        if (doc.runId) await api.graph.setMode(doc.runId, mode)
      })
      return docReadSnapshot(doc)
    },

    unloadNews(newsId) {
      graphs.delete(newsId)
    },

    onUpdated(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }

  return mapApi
}
