/**
 * Electron IPC Adapter — 维护每新闻一张内存图，翻译 LangGraph 事件与人的 CRUD。
 */
import { AppError, ErrorCode, toAppError } from '../../../electron/shared/errors'
import type { AddSubAgentInput, MapAPI, UpdateNodeParamsInput } from '../api'
import { NEWS_ROOT_ID, scopedVerifyInstanceId } from '../ids'
import {
  applyError,
  applyInterrupted,
  applyProgress,
  bootstrapFromNews,
  buildResumePatch,
  canAddSubAgent as canAddSubAgentPure,
  canEditNode as canEditNodePure,
  canRemoveNode as canRemoveNodePure,
  clearFocus,
  createEmptyDoc,
  ensureSubAgent,
  markRunCompleted,
  prepareForVerify,
  pruneRejectedClaims,
  resetIdleFromNews,
  syncDraftFromNodes,
  toSnapshot,
  type MapGraphDoc,
} from '../graph-doc'
import type {
  MapSubAgentParams,
  Priority,
} from '../types'
import type { ElectronAPI } from '../../../electron/api/types'

let slotSeq = 0
function nextInstanceId(agentName: string): string {
  slotSeq += 1
  return `${agentName}#${slotSeq}`
}

export function createElectronIpcMapAdapter(api: ElectronAPI): MapAPI {
  const listeners = new Set<(newsId: string) => void>()
  const graphs = new Map<string, MapGraphDoc>()

  function emit(newsId: string) {
    for (const l of listeners) l(newsId)
  }

  function getDoc(newsId: string): MapGraphDoc {
    let doc = graphs.get(newsId)
    if (!doc) {
      doc = createEmptyDoc(newsId)
      graphs.set(newsId, doc)
    }
    return doc
  }

  async function ensureGraph(newsId: string): Promise<MapGraphDoc> {
    const existing = graphs.get(newsId)
    if (existing && existing.nodes.length > 0) return existing

    const news = await api.news.get(newsId)
    if (!news) {
      const doc = createEmptyDoc(newsId)
      doc.error = `news not found: ${newsId}`
      graphs.set(newsId, doc)
      return doc
    }
    const doc = bootstrapFromNews(news, existing?.mode ?? 'human-in-loop')
    graphs.set(newsId, doc)
    return doc
  }

  function snapshotOf(newsId: string) {
    return toSnapshot(getDoc(newsId))
  }

  async function startNextVerify(newsId: string): Promise<void> {
    const doc = getDoc(newsId)
    // 只读 DB 判断「哪条 claim 还没核查」，不重建图
    const news = await api.news.get(newsId)
    if (!news) return

    const next = news.claims.find(c => !c.verifyResult)
    if (!next) {
      markRunCompleted(doc)
      return
    }

    prepareForVerify(doc)
    doc.graphType = 'verify'

    const { runId } = await api.graph.startVerify({
      newsId,
      claimId: next.claimId,
      mode: doc.mode,
    })
    doc.runId = runId
  }

  function wireEvents() {
    api.events.onInterrupted((payload) => {
      const newsId = payload.state.newsId
      const doc = getDoc(newsId)
      applyInterrupted(doc, payload)
      emit(newsId)
    })

    api.events.onCompleted((payload) => {
      const newsId = payload.state.newsId
      const doc = getDoc(newsId)
      doc.runId = undefined
      doc.runPhase = 'running'
      clearFocus(doc)
      void (async () => {
        try {
          await startNextVerify(newsId)
        } catch (e) {
          applyError(doc, toAppError(e).msg)
        }
        emit(newsId)
      })()
    })

    api.events.onError((payload) => {
      const doc = getDoc(payload.newsId)
      applyError(
        doc,
        payload.failedNode
          ? `[${payload.failedNode}] ${payload.msg}`
          : payload.msg,
      )
      doc.runId = undefined
      emit(payload.newsId)
    })

    api.events.onProgress((payload) => {
      const doc = getDoc(payload.newsId)
      applyProgress(doc, payload.runId, payload.graphType)
      emit(payload.newsId)
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
      const doc = await ensureGraph(input.newsId)
      const snap = toSnapshot(doc)
      if (!canAddSubAgentPure(snap, input.parentNodeId)) {
        throw new AppError(
          ErrorCode.MAP_CANNOT_ADD_SUBAGENT,
          `cannot add SubAgent under ${input.parentNodeId}`,
        )
      }
      let instanceId = input.params.instanceId
        ?? nextInstanceId(input.params.agentName)
      // 核查槽：instanceId 带 claimId，同名多槽不碰撞，且与 applyVerifyState 一致
      const parent = doc.nodes.find(n => n.id === input.parentNodeId)
      if (parent?.kind === 'claim') {
        instanceId = scopedVerifyInstanceId(parent.id, {
          agentName: input.params.agentName,
          instanceId,
        })
      }
      const route: MapSubAgentParams = {
        agentName: input.params.agentName,
        priority: input.params.priority,
        hint: input.params.hint,
        instanceId,
      }
      ensureSubAgent(doc, input.parentNodeId, route)
      syncDraftFromNodes(doc)
      emit(input.newsId)
      return snapshotOf(input.newsId)
    },

    async updateNodeParams(input: UpdateNodeParamsInput) {
      const doc = await ensureGraph(input.newsId)
      const snap = toSnapshot(doc)
      if (!canEditNodePure(snap, input.nodeId)) {
        throw new AppError(
          ErrorCode.MAP_CANNOT_EDIT_NODE,
          `cannot edit ${input.nodeId}`,
        )
      }
      const node = doc.nodes.find(n => n.id === input.nodeId)
      if (!node) {
        throw new AppError(
          ErrorCode.MAP_NODE_NOT_FOUND,
          `node not found: ${input.nodeId}`,
        )
      }

      if (node.kind === 'news') {
        const content = (input.params as { content?: string }).content
        if (content !== undefined) {
          node.params = { content }
          await api.news.update(input.newsId, { content })
        }
      } else if (node.kind === 'subAgent') {
        const patch = input.params as Partial<Pick<MapSubAgentParams, 'priority' | 'hint'>>
        node.params = {
          ...node.params,
          priority: (patch.priority ?? node.params.priority) as Priority,
          hint: patch.hint !== undefined ? patch.hint : node.params.hint,
        }
        syncDraftFromNodes(doc)
      } else if (node.kind === 'claim' && node.dataPhase === 'workerOut') {
        const patch = input.params as { content?: string; category?: string }
        node.params = {
          ...node.params,
          content: patch.content ?? node.params.content,
          category: patch.category !== undefined ? patch.category : node.params.category,
        }
        syncDraftFromNodes(doc)
      }

      emit(input.newsId)
      return snapshotOf(input.newsId)
    },

    async removeNode(input) {
      const doc = await ensureGraph(input.newsId)
      const snap = toSnapshot(doc)
      if (!canRemoveNodePure(snap, input.nodeId)) {
        throw new AppError(
          ErrorCode.MAP_CANNOT_REMOVE_NODE,
          `cannot remove ${input.nodeId}`,
        )
      }
      doc.nodes = doc.nodes.filter(n => n.id !== input.nodeId)
      doc.edges = doc.edges.filter(
        e => e.from !== input.nodeId && e.to !== input.nodeId,
      )
      syncDraftFromNodes(doc)
      emit(input.newsId)
      return snapshotOf(input.newsId)
    },

    async startRun(newsId, mode) {
      const doc = await ensureGraph(newsId)
      if (mode) doc.mode = mode
      doc.error = undefined
      doc.runPhase = 'running'
      doc.draft = undefined
      clearFocus(doc)
      // 去掉运行期节点，保留新闻
      const newsNode = doc.nodes.find(n => n.kind === 'news')
      doc.nodes = newsNode ? [newsNode] : []
      doc.edges = []

      try {
        const { runId } = await api.graph.startSplit({
          newsId,
          mode: doc.mode,
        })
        doc.runId = runId
        doc.graphType = 'split'
        emit(newsId)
        return { runId, snapshot: snapshotOf(newsId) }
      } catch (e) {
        applyError(doc, toAppError(e).msg)
        doc.runId = undefined
        emit(newsId)
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
        pruneRejectedClaims(doc)
      }
      syncDraftFromNodes(doc)
      const modifications = buildResumePatch(doc)

      doc.runPhase = 'running'
      clearFocus(doc)
      emit(newsId)
      await api.graph.resume(doc.runId, modifications)
      return snapshotOf(newsId)
    },

    async cancel(newsId) {
      const doc = getDoc(newsId)
      if (doc.runId) await api.graph.cancel(doc.runId)
      const news = await api.news.get(newsId)
      if (news) {
        resetIdleFromNews(doc, news)
      } else {
        doc.nodes = []
        doc.edges = []
        doc.runPhase = 'idle'
        doc.error = undefined
        doc.runId = undefined
        doc.graphType = undefined
        doc.draft = undefined
        clearFocus(doc)
      }
      emit(newsId)
      return snapshotOf(newsId)
    },

    async setMode(newsId, mode) {
      const doc = await ensureGraph(newsId)
      doc.mode = mode
      if (doc.runId) await api.graph.setMode(doc.runId, mode)
      emit(newsId)
      return snapshotOf(newsId)
    },

    onUpdated(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }

  return mapApi
}
