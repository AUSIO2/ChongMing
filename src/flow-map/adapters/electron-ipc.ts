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
  subAgentId,
  verifyInstanceId,
} from '../ids'
import {
  canAddSubAgent as canAddSubAgentPure,
  canEditNode as canEditNodePure,
  canRemoveNode as canRemoveNodePure,
} from '../graph-ops'
import type {
  ClaimMapNode,
  ExecutionMode,
  MapEdge,
  MapNode,
  MapSnapshot,
  NewsMapNode,
  OpinionMapNode,
  Priority,
  RunPhase,
  SubAgentEntry,
  SubAgentMapNode,
  SubAgentParams,
  ToolKind,
} from '../types'
import type {
  ActiveRunDTO,
  ElectronAPI,
  RouteInstruction,
  SplitGraphStateDTO,
  VerifyGraphStateDTO,
} from '../../../electron/api/types'

interface PendingSlot {
  parentNodeId: string
  params: SubAgentParams
  instanceId: string
}

interface NewsMeta {
  mode: ExecutionMode
  /** 双图切换时保持 running/completed，避免闪回 idle */
  phase?: RunPhase
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
  const lastRun = new Map<string, ActiveRunDTO>()
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
    pendingTool: ToolKind | undefined,
    runPhase: RunPhase,
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
    splitRoutes: RouteInstruction[],
  ): string {
    const source = sourceAgent ?? 'merge'
    const route = splitRoutes.find(r => r.agentName === source)
    const instanceId = route?.instanceId ?? source
    const parentId = subAgentId(instanceId)
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
      dataPhase: ClaimMapNode['dataPhase']
    },
  ): void {
    if (nodes.some(n => n.id === opts.id)) return
    const node: ClaimMapNode = {
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
    opts: {
      instanceId: string
      parentId: string
      params: SubAgentParams
    },
  ): void {
    const id = subAgentId(opts.instanceId)
    if (nodes.some(n => n.id === id)) return
    const node: SubAgentMapNode = {
      id,
      kind: 'subAgent',
      parentId: opts.parentId,
      params: { ...opts.params },
    }
    nodes.push(node)
    edges.push({
      id: edgeId(opts.parentId, id),
      from: opts.parentId,
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

    const newsNode: NewsMapNode = {
      id: NEWS_ROOT_ID,
      kind: 'news',
      params: { content: news.content },
    }
    nodes.push(newsNode)

    const pending = pendingByNews.get(newsId) ?? []
    const splitState = active?.graphType === 'split'
      ? active.state as SplitGraphStateDTO | undefined
      : undefined
    const verifyState = active?.graphType === 'verify'
      ? active.state as VerifyGraphStateDTO | undefined
      : undefined

    // —— 拆分 SubAgent ——
    const splitRoutes: RouteInstruction[] = splitState?.routeInstructions?.length
      ? splitState.routeInstructions
      : pending
        .filter(p => p.parentNodeId === NEWS_ROOT_ID)
        .map(p => ({
          agentName: p.params.agentName,
          priority: p.params.priority,
          hint: p.params.hint,
          instanceId: p.instanceId,
        }))

    for (const route of splitRoutes) {
      const instanceId = route.instanceId ?? route.agentName
      pushSubAgent(nodes, edges, {
        instanceId,
        parentId: NEWS_ROOT_ID,
        params: {
          agentName: route.agentName,
          displayLabel: route.agentName,
          priority: route.priority,
          hint: route.hint,
        },
      })
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
        const instanceId = route.instanceId
          ?? verifyInstanceId(claimNodeId, route.agentName)
        pushSubAgent(nodes, edges, {
          instanceId,
          parentId: claimNodeId,
          params: {
            agentName: route.agentName,
            displayLabel: route.agentName,
            priority: route.priority,
            hint: route.hint,
          },
        })
      }

      verifyState.subAgentOpinions.forEach((op, index) => {
        const route = verifyState.routeInstructions.find(r => r.agentName === op.agentName)
        const instanceId = route?.instanceId
          ?? verifyInstanceId(claimNodeId, op.agentName)
        const parentId = subAgentId(instanceId)
        if (!nodes.some(n => n.id === parentId)) {
          pushSubAgent(nodes, edges, {
            instanceId,
            parentId: claimNodeId,
            params: {
              agentName: op.agentName,
              displayLabel: op.agentName,
              priority: op.priority,
            },
          })
        }
        const id = opinionNodeId(claimNodeId, index)
        const persisted = index < verifyState.opinionSaveIndex
        const node: OpinionMapNode = {
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
          const instanceId = verifyInstanceId(c.claimId, op.agentName)
          const parentId = subAgentId(instanceId)
          if (!nodes.some(n => n.id === parentId)) {
            pushSubAgent(nodes, edges, {
              instanceId,
              parentId: c.claimId,
              params: {
                agentName: op.agentName,
                displayLabel: op.agentName,
                priority: op.priority,
              },
            })
          }
          const id = opinionNodeId(c.claimId, index)
          if (nodes.some(n => n.id === id)) return
          const node: OpinionMapNode = {
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
            && n.params.agentName === p.params.agentName,
        )
      ) {
        continue
      }
      pushSubAgent(nodes, edges, {
        instanceId: p.instanceId,
        parentId: p.parentNodeId,
        params: p.params,
      })
    }

    let runPhase: RunPhase = meta.phase ?? 'idle'
    let activeNodeId: string | undefined
    let pendingTool: ToolKind | undefined
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
  ): RouteInstruction[] {
    return (pendingByNews.get(newsId) ?? [])
      .filter(p => p.parentNodeId === parentNodeId)
      .map(p => ({
        agentName: p.params.agentName,
        priority: p.params.priority,
        hint: p.params.hint,
        instanceId: p.instanceId,
      }))
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
      const list = await api.catalog.list(module)
      return list.map((e): SubAgentEntry => ({
        agentName: e.agentName,
        displayLabel: e.displayLabel,
        description: e.description,
        defaultPriority: e.defaultPriority,
      }))
    },

    async addSubAgent(input: AddSubAgentInput) {
      const snap = await project(input.newsId)
      if (!canAddSubAgentPure(snap, input.parentNodeId)) {
        throw new Error(`cannot add SubAgent under ${input.parentNodeId}`)
      }
      const instanceId = nextInstanceId(input.params.agentName)
      const list = pendingByNews.get(input.newsId) ?? []
      list.push({
        parentNodeId: input.parentNodeId,
        params: input.params,
        instanceId,
      })
      pendingByNews.set(input.newsId, list)

      const active = lastRun.get(input.newsId)
      if (
        active?.state
        && 'routeInstructions' in active.state
        && active.pendingTool === 'invoke'
      ) {
        const routes = [...active.state.routeInstructions]
        routes.push({
          agentName: input.params.agentName,
          priority: input.params.priority,
          hint: input.params.hint,
          instanceId,
        })
        active.state = { ...active.state, routeInstructions: routes }
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
        const active = lastRun.get(input.newsId)
        if (active?.state && 'routeInstructions' in active.state) {
          const patch = input.params as Partial<SubAgentParams>
          const routes = active.state.routeInstructions.map((r) => {
            const rid = subAgentId(r.instanceId ?? r.agentName)
            if (rid !== input.nodeId) return r
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
          if (subAgentId(p.instanceId) === input.nodeId) {
            Object.assign(p.params, input.params)
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
        pending.filter(p => subAgentId(p.instanceId) !== input.nodeId),
      )
      const active = lastRun.get(input.newsId)
      if (
        active?.state
        && 'routeInstructions' in active.state
        && active.pendingTool === 'invoke'
      ) {
        active.state = {
          ...active.state,
          routeInstructions: active.state.routeInstructions.filter((r) => {
            const id = subAgentId(r.instanceId ?? r.agentName)
            return id !== input.nodeId
          }),
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
