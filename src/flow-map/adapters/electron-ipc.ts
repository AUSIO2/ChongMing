/**
 * Electron IPC Adapter — 把真实 LangGraph 双图投影为 MapSnapshot。
 * UI / Port 永不直接碰 startSplit / startVerify / routeInstructions。
 */
import type { AddSubAgentInput, MapAPI, UpdateNodeParamsInput } from '../api'
import {
  NEWS_ROOT_ID,
  edgeId,
  mergedClaimNodeId,
  opinionNodeId,
  routeInstanceId,
  routeNodeId,
  subAgentId,
  verifyInstanceId,
} from '../ids'
import {
  canAddSubAgent as canAddSubAgentPure,
  canEditNode as canEditNodePure,
  canRemoveNode as canRemoveNodePure,
} from '../graph-ops'
import type {
  MapClaimNode,
  ExecutionMode,
  MapEdge,
  MapNode,
  MapSnapshot,
  MapNewsNode,
  MapOpinionNode,
  Priority,
  MapSubAgentParams,
  MapRunPhase,
  MapSubAgentNode,
  MapToolKind,
} from '../types'
import type {
  GraphActiveRun,
  ElectronAPI,
  GraphSplitState,
  GraphVerifyState,
} from '../../../electron/api/types'

/** 人工预置槽：完整 MapSubAgentParams（instanceId 已定）。 */
interface PendingSlot {
  parentNodeId: string
  route: MapSubAgentParams
}

interface NewsMeta {
  mode: ExecutionMode
  /** 双图切换时保持 running/completed，避免闪回 idle */
  phase?: MapRunPhase
  error?: string
}

let slotSeq = 0
function nextInstanceId(agentName: string): string {
  slotSeq += 1
  return `${agentName}#${slotSeq}`
}

export function createElectronIpcMapAdapter(api: ElectronAPI): MapAPI {
  const listeners = new Set<(newsId: string) => void>()
  /** idle / invoke 配置期人工预置槽 */
  const pendingByNews = new Map<string, PendingSlot[]>()
  /** 最近一次 interrupt / 活跃 run */
  const lastRun = new Map<string, GraphActiveRun>()
  const metaByNews = new Map<string, NewsMeta>()

  function emit(newsId: string) {
    for (const l of listeners) l(newsId)
  }

  function getMeta(newsId: string): NewsMeta {
    let m = metaByNews.get(newsId)
    if (!m) {
      m = { mode: 'human-in-loop' }
      metaByNews.set(newsId, m)
    }
    return m
  }

  function attachFocus(
    nodes: MapNode[],
    activeNodeId: string | undefined,
    pendingTool: MapToolKind | undefined,
    runPhase: MapRunPhase,
  ): void {
    if (!activeNodeId || !pendingTool) return
    const focus = nodes.find(n => n.id === activeNodeId)
    if (!focus) return
    if (runPhase === 'interrupted') {
      focus.runtime = { pendingTool }
    } else if (runPhase === 'running') {
      focus.runtime = { activeTool: pendingTool }
    }
  }

  function resolveClaimParent(
    nodes: MapNode[],
    sourceAgent: string | undefined,
    splitRoutes: MapSubAgentParams[],
  ): string {
    const source = sourceAgent ?? 'merge'
    const route = splitRoutes.find(r => r.agentName === source)
    const parentId = route
      ? routeNodeId(route)
      : subAgentId(source)
    return nodes.some(n => n.id === parentId) ? parentId : NEWS_ROOT_ID
  }

  function pushClaim(
    nodes: MapNode[],
    edges: MapEdge[],
    opts: {
      id: string
      parentId: string
      content: string
      category?: string
      sourceAgent?: string
      dataPhase: MapClaimNode['dataPhase']
    },
  ): void {
    if (nodes.some(n => n.id === opts.id)) return
    const node: MapClaimNode = {
      id: opts.id,
      kind: 'claim',
      parentId: opts.parentId,
      params: {
        content: opts.content,
        category: opts.category,
        sourceAgent: opts.sourceAgent,
      },
      dataPhase: opts.dataPhase,
    }
    nodes.push(node)
    edges.push({
      id: edgeId(opts.parentId, opts.id),
      from: opts.parentId,
      to: opts.id,
    })
  }

  function pushSubAgent(
    nodes: MapNode[],
    edges: MapEdge[],
    parentId: string,
    route: MapSubAgentParams,
  ): void {
    const id = routeNodeId(route)
    if (nodes.some(n => n.id === id)) return
    const params: MapSubAgentParams = {
      ...route,
      instanceId: routeInstanceId(route),
    }
    const node: MapSubAgentNode = {
      id,
      kind: 'subAgent',
      parentId,
      params,
    }
    nodes.push(node)
    edges.push({
      id: edgeId(parentId, id),
      from: parentId,
      to: id,
    })
  }

  async function project(newsId: string): Promise<MapSnapshot> {
    const meta = getMeta(newsId)
    const news = await api.news.get(newsId)
    if (!news) {
      return {
        newsId,
        nodes: [],
        edges: [],
        runPhase: 'idle',
        mode: meta.mode,
        error: `news not found: ${newsId}`,
      }
    }

    const active = (await api.graph.getActiveRun(newsId)) ?? lastRun.get(newsId) ?? null
    if (active) lastRun.set(newsId, active)

    const nodes: MapNode[] = []
    const edges: MapEdge[] = []

    const newsNode: MapNewsNode = {
      id: NEWS_ROOT_ID,
      kind: 'news',
      params: { content: news.content },
    }
    nodes.push(newsNode)

    const pending = pendingByNews.get(newsId) ?? []
    const splitState = active?.graphType === 'split'
      ? active.state as GraphSplitState | undefined
      : undefined
    const verifyState = active?.graphType === 'verify'
      ? active.state as GraphVerifyState | undefined
      : undefined

    // —— 拆分 SubAgent ——
    const splitRoutes: MapSubAgentParams[] = splitState?.routeInstructions?.length
      ? splitState.routeInstructions
      : pending
        .filter(p => p.parentNodeId === NEWS_ROOT_ID)
        .map(p => p.route)

    for (const route of splitRoutes) {
      pushSubAgent(nodes, edges, NEWS_ROOT_ID, route)
    }

    // —— Claims：优先 merge 游标（与 focus id 对齐），否则已落库 ——
    if (splitState?.mergedClaims?.length) {
      splitState.mergedClaims.forEach((c, index) => {
        const id = mergedClaimNodeId(index)
        const persisted = index < splitState.saveIndex
        const parentId = resolveClaimParent(nodes, c.sourceAgent, splitRoutes)
        pushClaim(nodes, edges, {
          id,
          parentId,
          content: c.content,
          category: c.category,
          sourceAgent: c.sourceAgent,
          dataPhase: persisted ? 'persisted' : 'workerOut',
        })
      })
    } else {
      for (const c of news.claims) {
        const parentId = resolveClaimParent(nodes, c.sourceAgent, splitRoutes)
        pushClaim(nodes, edges, {
          id: c.claimId,
          parentId,
          content: c.content,
          category: c.category,
          sourceAgent: c.sourceAgent,
          dataPhase: 'persisted',
        })
      }
    }

    // —— 核查槽 + opinions ——
    if (verifyState) {
      const claimNodeId = verifyState.claimId
      for (const route of verifyState.routeInstructions) {
        pushSubAgent(nodes, edges, claimNodeId, {
          ...route,
          instanceId: route.instanceId
            ?? verifyInstanceId(claimNodeId, route.agentName),
        })
      }

      verifyState.subAgentOpinions.forEach((op, index) => {
        const route = verifyState.routeInstructions.find(r => r.agentName === op.agentName)
        const routeForOp: MapSubAgentParams = {
          agentName: op.agentName,
          priority: route?.priority ?? op.priority,
          hint: route?.hint,
          instanceId: route?.instanceId
            ?? verifyInstanceId(claimNodeId, op.agentName),
        }
        const parentId = routeNodeId(routeForOp)
        if (!nodes.some(n => n.id === parentId)) {
          pushSubAgent(nodes, edges, claimNodeId, routeForOp)
        }
        const id = opinionNodeId(claimNodeId, index)
        const persisted = index < verifyState.opinionSaveIndex
        const node: MapOpinionNode = {
          id,
          kind: 'opinion',
          parentId,
          params: {
            content: op.reason,
            confidence: op.score,
            priority: op.priority,
          },
          dataPhase: persisted ? 'persisted' : 'workerOut',
        }
        nodes.push(node)
        edges.push({ id: edgeId(parentId, id), from: parentId, to: id })
      })
    } else {
      for (const c of news.claims) {
        const opinions = c.verifyResult?.opinions ?? []
        opinions.forEach((op, index) => {
          const routeForOp: MapSubAgentParams = {
            agentName: op.agentName,
            priority: op.priority,
            instanceId: verifyInstanceId(c.claimId, op.agentName),
          }
          const parentId = routeNodeId(routeForOp)
          if (!nodes.some(n => n.id === parentId)) {
            pushSubAgent(nodes, edges, c.claimId, routeForOp)
          }
          const id = opinionNodeId(c.claimId, index)
          if (nodes.some(n => n.id === id)) return
          const node: MapOpinionNode = {
            id,
            kind: 'opinion',
            parentId,
            params: {
              content: op.reason,
              confidence: op.score,
              priority: op.priority,
            },
            dataPhase: 'persisted',
          }
          nodes.push(node)
          edges.push({ id: edgeId(parentId, id), from: parentId, to: id })
        })
      }
    }

    // idle / 配置期人工预置的核查槽
    for (const p of pending) {
      if (p.parentNodeId === NEWS_ROOT_ID) continue
      if (
        nodes.some(
          n =>
            n.kind === 'subAgent'
            && n.parentId === p.parentNodeId
            && n.params.agentName === p.route.agentName,
        )
      ) {
        continue
      }
      pushSubAgent(nodes, edges, p.parentNodeId, p.route)
    }

    let runPhase: MapRunPhase = meta.phase ?? 'idle'
    let activeNodeId: string | undefined
    let pendingTool: MapToolKind | undefined
    let mode: ExecutionMode = meta.mode

    if (meta.error) {
      runPhase = 'error'
    } else if (active) {
      mode = active.mode
      meta.mode = active.mode
      runPhase = active.focus ? 'interrupted' : 'running'
      meta.phase = runPhase
      activeNodeId = active.focus?.id
      pendingTool = active.pendingTool
      attachFocus(nodes, activeNodeId, pendingTool, runPhase)
    } else if (meta.phase === 'completed') {
      runPhase = 'completed'
    } else if (meta.phase === 'running') {
      // 双图切换间隙
      runPhase = 'running'
    }

    return {
      newsId,
      nodes,
      edges,
      runPhase,
      mode,
      activeNodeId,
      pendingTool,
      error: meta.error,
    }
  }

  function pendingRoutesFor(
    newsId: string,
    parentNodeId: string,
  ): MapSubAgentParams[] {
    return (pendingByNews.get(newsId) ?? [])
      .filter(p => p.parentNodeId === parentNodeId)
      .map(p => p.route)
  }

  async function startNextVerify(newsId: string): Promise<void> {
    const meta = getMeta(newsId)
    const news = await api.news.get(newsId)
    if (!news) return

    const next = news.claims.find(c => !c.verifyResult)
    if (!next) {
      meta.phase = 'completed'
      meta.error = undefined
      lastRun.delete(newsId)
      return
    }

    meta.phase = 'running'
    meta.error = undefined
    const routeInstructions = pendingRoutesFor(newsId, next.claimId)
    const { runId } = await api.graph.startVerify({
      newsId,
      claimId: next.claimId,
      mode: meta.mode,
      ...(routeInstructions.length ? { routeInstructions } : {}),
    })
    lastRun.set(newsId, {
      runId,
      newsId,
      graphType: 'verify',
      mode: meta.mode,
    })
  }

  function wireEvents() {
    api.events.onInterrupted((payload) => {
      const newsId = payload.state.newsId
      const meta = getMeta(newsId)
      meta.error = undefined
      meta.phase = 'interrupted'
      meta.mode = payload.mode
      lastRun.set(newsId, {
        runId: payload.runId,
        newsId,
        graphType: payload.graphType,
        mode: payload.mode,
        nextNode: payload.nextNode,
        focus: payload.focus,
        pendingTool: payload.pendingTool,
        state: payload.state,
      })
      emit(newsId)
    })

    api.events.onCompleted((payload) => {
      const newsId = payload.state.newsId
      lastRun.delete(newsId)
      // 双图切换间隙保持 running，避免 UI 闪回 idle
      getMeta(newsId).phase = 'running'
      void (async () => {
        try {
          await startNextVerify(newsId)
        } catch (e) {
          const meta = getMeta(newsId)
          meta.phase = 'error'
          meta.error = e instanceof Error ? e.message : String(e)
        }
        emit(newsId)
      })()
    })

    api.events.onError((payload) => {
      for (const [newsId, run] of lastRun) {
        if (run.runId !== payload.runId) continue
        const meta = getMeta(newsId)
        meta.phase = 'error'
        meta.error = payload.error
        emit(newsId)
        break
      }
    })

    api.events.onProgress((payload) => {
      for (const [newsId, run] of lastRun) {
        if (run.runId === payload.runId) emit(newsId)
      }
    })
  }

  wireEvents()

  const mapApi: MapAPI = {
    async getSnapshot(newsId) {
      return project(newsId)
    },

    async getSubAgentCatalog(parentNodeId) {
      const module = parentNodeId === NEWS_ROOT_ID ? 'split' : 'verify'
      return api.catalog.list(module)
    },

    async addSubAgent(input: AddSubAgentInput) {
      const snap = await project(input.newsId)
      if (!canAddSubAgentPure(snap, input.parentNodeId)) {
        throw new Error(`cannot add SubAgent under ${input.parentNodeId}`)
      }
      const route: MapSubAgentParams = {
        agentName: input.params.agentName,
        priority: input.params.priority,
        hint: input.params.hint,
        instanceId: input.params.instanceId
          ?? nextInstanceId(input.params.agentName),
      }
      const list = pendingByNews.get(input.newsId) ?? []
      list.push({ parentNodeId: input.parentNodeId, route })
      pendingByNews.set(input.newsId, list)

      const active = lastRun.get(input.newsId)
      if (
        active?.state
        && 'routeInstructions' in active.state
        && active.pendingTool === 'invoke'
      ) {
        active.state = {
          ...active.state,
          routeInstructions: [...active.state.routeInstructions, route],
        }
        lastRun.set(input.newsId, active)
      }

      emit(input.newsId)
      return project(input.newsId)
    },

    async updateNodeParams(input: UpdateNodeParamsInput) {
      const snap = await project(input.newsId)
      if (!canEditNodePure(snap, input.nodeId)) {
        throw new Error(`cannot edit ${input.nodeId}`)
      }
      const node = snap.nodes.find(n => n.id === input.nodeId)
      if (!node) throw new Error(`node not found: ${input.nodeId}`)

      if (node.kind === 'news') {
        const content = (input.params as { content?: string }).content
        if (content !== undefined) await api.news.update(input.newsId, { content })
      } else if (node.kind === 'subAgent') {
        const patch = input.params as Partial<Pick<MapSubAgentParams, 'priority' | 'hint'>>
        const active = lastRun.get(input.newsId)
        if (active?.state && 'routeInstructions' in active.state) {
          const routes = active.state.routeInstructions.map((r) => {
            if (routeNodeId(r) !== input.nodeId) return r
            return {
              ...r,
              priority: (patch.priority ?? r.priority) as Priority,
              hint: patch.hint !== undefined ? patch.hint : r.hint,
            }
          })
          active.state = { ...active.state, routeInstructions: routes }
          lastRun.set(input.newsId, active)
        }
        const pending = pendingByNews.get(input.newsId) ?? []
        for (const p of pending) {
          if (routeNodeId(p.route) === input.nodeId) {
            if (patch.priority !== undefined) p.route.priority = patch.priority
            if (patch.hint !== undefined) p.route.hint = patch.hint
          }
        }
      } else if (node.kind === 'claim' && node.dataPhase === 'workerOut') {
        // workerOut claim 仅存在于 active split state.mergedClaims
        const active = lastRun.get(input.newsId)
        if (active?.state && 'mergedClaims' in active.state) {
          const patch = input.params as { content?: string; category?: string }
          const claims = active.state.mergedClaims.map((c, i) => {
            if (mergedClaimNodeId(i) !== input.nodeId) return c
            return {
              ...c,
              content: patch.content ?? c.content,
              category: patch.category !== undefined ? patch.category : c.category,
            }
          })
          active.state = { ...active.state, mergedClaims: claims }
          lastRun.set(input.newsId, active)
        }
      }

      emit(input.newsId)
      return project(input.newsId)
    },

    async removeNode(input) {
      const snap = await project(input.newsId)
      if (!canRemoveNodePure(snap, input.nodeId)) {
        throw new Error(`cannot remove ${input.nodeId}`)
      }
      const pending = pendingByNews.get(input.newsId) ?? []
      pendingByNews.set(
        input.newsId,
        pending.filter(p => routeNodeId(p.route) !== input.nodeId),
      )
      const active = lastRun.get(input.newsId)
      if (
        active?.state
        && 'routeInstructions' in active.state
        && active.pendingTool === 'invoke'
      ) {
        active.state = {
          ...active.state,
          routeInstructions: active.state.routeInstructions.filter(
            r => routeNodeId(r) !== input.nodeId,
          ),
        }
        lastRun.set(input.newsId, active)
      }
      emit(input.newsId)
      return project(input.newsId)
    },

    async startRun(newsId, mode) {
      const meta = getMeta(newsId)
      if (mode) meta.mode = mode
      meta.error = undefined
      meta.phase = 'running'

      const routeInstructions = pendingRoutesFor(newsId, NEWS_ROOT_ID)
      const { runId } = await api.graph.startSplit({
        newsId,
        mode: meta.mode,
        ...(routeInstructions.length ? { routeInstructions } : {}),
      })
      lastRun.set(newsId, {
        runId,
        newsId,
        graphType: 'split',
        mode: meta.mode,
      })
      emit(newsId)
      return { runId, snapshot: await project(newsId) }
    },

    async continueStep(newsId) {
      const active = (await api.graph.getActiveRun(newsId)) ?? lastRun.get(newsId)
      if (!active?.runId) return project(newsId)

      const cached = lastRun.get(newsId)
      const state = cached?.state
      const modifications = state && 'routeInstructions' in state
        ? {
            routeInstructions: state.routeInstructions,
            ...('mergedClaims' in state ? { mergedClaims: state.mergedClaims } : {}),
          }
        : null

      getMeta(newsId).phase = 'running'
      await api.graph.resume(active.runId, modifications)
      return project(newsId)
    },

    async cancel(newsId) {
      const active = (await api.graph.getActiveRun(newsId)) ?? lastRun.get(newsId)
      if (active?.runId) await api.graph.cancel(active.runId)
      lastRun.delete(newsId)
      const meta = getMeta(newsId)
      meta.phase = 'idle'
      meta.error = undefined
      emit(newsId)
      return project(newsId)
    },

    async setMode(newsId, mode) {
      const meta = getMeta(newsId)
      meta.mode = mode
      const active = (await api.graph.getActiveRun(newsId)) ?? lastRun.get(newsId)
      if (active?.runId) await api.graph.setMode(active.runId, mode)
      emit(newsId)
      return project(newsId)
    },

    onUpdated(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }

  return mapApi
}
