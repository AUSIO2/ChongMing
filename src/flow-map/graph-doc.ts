/**
 * Map 层内存图：按 newsId 维护一张可变图，整合 LangGraph 事件与人的 CRUD。
 * 含快照上的能力判定（锁 / canAdd / canEdit / canRemove）。
 */
import {
  NEWS_ROOT_ID,
  mapIdReadDraftIndex,
  mapIdCreateDraftClaim,
  mapIdCreateEdge,
  mapIdIsDraftClaim,
  mapIdCreateClaim,
  mapIdCreateOpinion,
  mapIdReadSubAgent,
  mapIdCreateRoute,
} from './ids'
import type {
  ExecutionMode,
  MapClaimNode,
  MapEdge,
  MapNode,
  MapNewsNode,
  MapOpinionNode,
  MapRunPhase,
  MapSnapshot,
  MapSubAgentNode,
  MapSubAgentParams,
  MapToolKind,
  Priority,
} from './types'
import {
  apiCanWriteRoute,
  type DisplayNews,
  type GraphInterruptNode,
  type GraphInterruptedPayload,
  type GraphProgressPayload,
  type GraphSplitState,
  type GraphStatePatch,
  type GraphType,
  type GraphVerifyState,
  type MapGraphPersist,
  type MapRunPersist,
} from '../../electron/api/types'

export interface MapGraphDoc {
  newsId: string
  nodes: MapNode[]
  edges: MapEdge[]
  runPhase: MapRunPhase
  mode: ExecutionMode
  activeNodeId?: string
  pendingTool?: MapToolKind
  /** LangGraph 中断门闩，与 pendingTool 对应 */
  nextNode?: GraphInterruptNode
  runId?: string
  threadId?: string
  graphType?: GraphType
  draft?: GraphSplitState | GraphVerifyState
  error?: string
}

export function docReadSnapshot(doc: MapGraphDoc): MapSnapshot {
  return {
    newsId: doc.newsId,
    nodes: doc.nodes.map(n => ({ ...n, params: { ...n.params } }) as MapNode),
    edges: doc.edges.map(e => ({ ...e })),
    runPhase: doc.runPhase,
    mode: doc.mode,
    activeNodeId: doc.activeNodeId,
    pendingTool: doc.pendingTool,
    error: doc.error,
  }
}

export function docCreate(newsId: string, mode: ExecutionMode = 'human-in-loop'): MapGraphDoc {
  return {
    newsId,
    nodes: [],
    edges: [],
    runPhase: 'idle',
    mode,
  }
}

/** 从 DB 新闻构建 idle 图（新闻 + 拆分槽历史 + claim/opinion）。 */
export function docCreateNews(
  news: DisplayNews,
  mode: ExecutionMode = 'human-in-loop',
): MapGraphDoc {
  const doc = docCreate(news._id, mode)
  docUpdateNews(doc, news.content)

  const splitRoutes = docReadNewsRoutes(news)
  docUpdateSplitRoutes(doc, splitRoutes)

  for (const c of news.claims) {
    const claimParent = docReadClaimParent(
      doc.nodes,
      { agentName: c.sourceAgent },
      splitRoutes,
    )
    docUpdateClaim(doc, {
      id: c.claimId,
      parentId: claimParent,
      content: c.content,
      category: c.category,
      sourceAgent: c.sourceAgent,
      dataPhase: 'persisted',
      shouldSave: true,
    })

    const opinions = c.verifyResult?.opinions ?? []
    docUpdateVerifyOpinions(doc, c.claimId, [], opinions, opinions.length)
  }

  doc.runPhase = 'idle'
  doc.error = undefined
  docDeleteFocus(doc)
  return doc
}

/** 从 splitMeta.routeInstructions 还原拆分槽位。 */
function docReadNewsRoutes(news: DisplayNews): MapSubAgentParams[] {
  const routes = news.splitMeta?.routeInstructions
  if (!routes?.length) return []
  return routes.map(r => ({
    agentName: r.agentName,
    priority: r.priority,
    hint: r.hint,
    instanceId: r.instanceId,
  }))
}

export function docUpdateProgress(doc: MapGraphDoc, payload: GraphProgressPayload): void {
  if (doc.runPhase === 'error' || doc.runPhase === 'completed') return
  if (!doc.runId || payload.runId !== doc.runId) return

  doc.graphType = payload.graphType

  if (payload.event === 'subagent_tool') {
    docUpdateToolProgress(doc, payload)
    return
  }

  docUpdateGraphProgress(doc, payload)
}

function docReadDraftRoute(
  doc: MapGraphDoc,
  nodeId: string,
): MapSubAgentParams | undefined {
  const instanceId = mapIdReadSubAgent(nodeId)
  if (!instanceId) return undefined
  const draft = doc.draft
  if (!draft || !('routeInstructions' in draft)) return undefined
  return draft.routeInstructions?.find(r => mapIdCreateRoute(r) === nodeId)
}

type GraphRunProgressPayload = Exclude<GraphProgressPayload, { event: 'subagent_tool' }>
type GraphFanoutSpawnPayload = GraphRunProgressPayload & { event: 'fanout_spawn' }

function docUpdateFanoutSubAgent(
  doc: MapGraphDoc,
  payload: GraphFanoutSpawnPayload,
): void {
  if (!payload.nodeId || !payload.parentNodeId) return
  const instanceId = mapIdReadSubAgent(payload.nodeId)
  if (!instanceId || !payload.agentName) return
  const route = docReadDraftRoute(doc, payload.nodeId) ?? {
    agentName: payload.agentName,
    instanceId,
    priority: 'medium' as Priority,
  }
  docUpdateSubAgent(doc, payload.parentNodeId, route)
}

function docUpdateToolProgress(
  doc: MapGraphDoc,
  payload: Extract<GraphProgressPayload, { event: 'subagent_tool' }>,
): void {
  if (doc.runPhase !== 'running') {
    doc.runPhase = 'running'
    doc.pendingTool = undefined
  }

  const node = doc.nodes.find(n => n.id === payload.nodeId)
  if (!node) return

  if (payload.phase === 'start') {
    node.runtime = {
      ...node.runtime,
      activeSkill: {
        name: payload.toolName,
        argsSummary: payload.argsSummary,
      },
    }
    return
  }

  docDeleteSkill(node)
}

function docUpdateGraphProgress(
  doc: MapGraphDoc,
  payload: GraphRunProgressPayload,
): void {
  const focusId = doc.activeNodeId
  const tool = doc.pendingTool
  doc.runPhase = 'running'
  doc.pendingTool = undefined
  docDeleteHitlRuntime(doc)

  if (payload.event === 'fanout_spawn' && payload.nodeId) {
    docUpdateFanoutSubAgent(doc, payload as GraphFanoutSpawnPayload)
  }

  if (payload.event === 'node_exit' && payload.node === 'subAgent') {
    docDeleteSubAgentSkill(doc)
  }

  if (focusId && tool) {
    doc.activeNodeId = focusId
    const node = doc.nodes.find(n => n.id === focusId)
    if (node) node.runtime = { ...node.runtime, activeTool: tool }
  } else {
    doc.activeNodeId = undefined
  }
}

export function docUpdateError(doc: MapGraphDoc, message: string): void {
  doc.runPhase = 'error'
  doc.error = message
  docDeleteFocus(doc)
}

export function docUpdateInterrupt(doc: MapGraphDoc, payload: GraphInterruptedPayload): void {
  if (
    doc.runPhase === 'interrupted'
    && doc.runId === payload.runId
    && doc.nextNode === payload.nextNode
  ) {
    return
  }

  doc.error = undefined
  doc.runPhase = 'interrupted'
  doc.mode = payload.mode
  doc.runId = payload.runId
  doc.graphType = payload.graphType
  doc.nextNode = payload.nextNode
  doc.pendingTool = payload.pendingTool
  doc.activeNodeId = payload.focus?.id
  doc.draft = payload.state

  if (payload.graphType === 'split') {
    const splitState = payload.state as GraphSplitState
    doc.nodes = []
    doc.edges = []
    docUpdateNews(doc, splitState.content)
    docUpdateSplitState(doc, splitState)
  } else {
    docUpdateClaimPersist(doc)
    docUpdateVerifyState(doc, payload.state as GraphVerifyState)
  }

  docUpdateFocus(doc)
}

/** split 完成进入 verify：不读 DB，只整理内存图运行态。 */
export function docUpdateVerify(doc: MapGraphDoc): void {
  docUpdateClaimPersist(doc)
  docDeleteNodes(doc, new Set(docReadDraftClaims(doc).map(n => n.id)))
  doc.draft = undefined
  doc.error = undefined
  doc.runPhase = 'running'
  docDeleteFocus(doc)
}

export function docUpdateRunComplete(doc: MapGraphDoc): void {
  docUpdateClaimPersist(doc)
  doc.runPhase = 'completed'
  doc.runId = undefined
  doc.threadId = undefined
  doc.graphType = undefined
  doc.nextNode = undefined
  doc.draft = undefined
  doc.error = undefined
  docDeleteFocus(doc)
}

/** 从 News.mapGraph 恢复内存图 */
export function docCreatePersist(
  newsId: string,
  persist: MapGraphPersist,
  mapRun?: MapRunPersist,
): MapGraphDoc {
  return {
    newsId,
    nodes: (persist.nodes ?? []) as MapNode[],
    edges: (persist.edges ?? []) as MapEdge[],
    runPhase: (persist.runPhase as MapRunPhase) ?? 'idle',
    mode: persist.mode ?? 'human-in-loop',
    activeNodeId: persist.activeNodeId,
    pendingTool: persist.pendingTool,
    nextNode: persist.nextNode,
    graphType: persist.graphType,
    draft: persist.draft,
    error: persist.error,
    runId: mapRun?.runId,
    threadId: mapRun?.threadId,
  }
}

/** 序列化内存图供写入 News.mapGraph */
export function docReadPersistGraph(doc: MapGraphDoc): MapGraphPersist {
  return {
    nodes: doc.nodes,
    edges: doc.edges,
    runPhase: doc.runPhase,
    mode: doc.mode,
    activeNodeId: doc.activeNodeId,
    pendingTool: doc.pendingTool,
    nextNode: doc.nextNode,
    graphType: doc.graphType,
    draft: doc.draft,
    error: doc.error,
    updatedAt: new Date().toISOString(),
  }
}

/** 序列化运行会话供写入 News.mapRun */
export function docReadPersistRun(doc: MapGraphDoc): MapRunPersist | null {
  if (!doc.runId || !doc.threadId || !doc.graphType) return null
  const status =
    doc.runPhase === 'error'
      ? 'error'
      : doc.runPhase === 'interrupted'
        ? 'interrupted'
        : doc.runPhase === 'running'
          ? 'running'
          : null
  if (!status) return null

  const claimId =
    doc.draft && 'claimId' in doc.draft ? doc.draft.claimId : undefined

  return {
    runId: doc.runId,
    threadId: doc.threadId,
    graphType: doc.graphType,
    mode: doc.mode,
    gate: doc.nextNode,
    pendingTool: doc.pendingTool,
    activeNodeId: doc.activeNodeId,
    status,
    claimId,
    updatedAt: new Date().toISOString(),
  }
}

/** 用 DB 新闻重建 idle 图，清空运行态字段。 */
export function docResetNews(doc: MapGraphDoc, news: DisplayNews): void {
  const mode = doc.mode
  const next = docCreateNews(news, mode)
  doc.newsId = next.newsId
  doc.nodes = next.nodes
  doc.edges = next.edges
  doc.mode = mode
  docDeleteRunSession(doc)
}

function docUpdateClaimPersist(doc: MapGraphDoc): void {
  for (const n of doc.nodes) {
    if (n.kind === 'claim' || n.kind === 'opinion') {
      n.dataPhase = 'persisted'
    }
    if (n.kind === 'claim') {
      n.shouldSave = true
    }
  }
}

/** 剔除 shouldSave=false 的草稿 claim。 */
export function docDeleteClaims(doc: MapGraphDoc): void {
  const removed = new Set(
    doc.nodes
      .filter((n): n is MapClaimNode => n.kind === 'claim' && !n.shouldSave)
      .map(n => n.id),
  )
  docDeleteNodes(doc, removed)
}

export function docReadResume(doc: MapGraphDoc): GraphStatePatch {
  const state = doc.draft
  if (!state) return null

  if (apiCanWriteRoute(doc.pendingTool) && 'routeInstructions' in state) {
    return { routeInstructions: state.routeInstructions }
  }

  if (
    (doc.pendingTool === 'validate' || doc.pendingTool === 'save')
    && 'mergedClaims' in state
    && state.mergedClaims.length > 0
  ) {
    return { mergedClaims: state.mergedClaims }
  }

  return null
}

/** 从图上 subAgent / claim 写回 draft，供 resume。 */
export function docUpdateDraft(doc: MapGraphDoc): void {
  if (!doc.draft) return

  if (doc.graphType === 'split' && 'routeInstructions' in doc.draft) {
    const routes = doc.nodes
      .filter((n): n is MapSubAgentNode => n.kind === 'subAgent' && n.parentId === NEWS_ROOT_ID)
      .map(n => ({ ...n.params }))
    doc.draft = { ...doc.draft, routeInstructions: routes }

    if ('mergedClaims' in doc.draft) {
      const numbered = doc.nodes
        .filter((n): n is MapClaimNode => n.kind === 'claim' && !mapIdIsDraftClaim(n.id))
        .sort((a, b) => Number(a.id) - Number(b.id))

      const source = numbered.length > 0
        ? numbered
        : docReadDraftClaims(doc).filter(n => n.shouldSave)

      const claims = source.map(n => ({
        content: n.params.content,
        category: n.params.category,
        sourceAgent: n.params.sourceAgent,
        shouldSave: true as boolean,
      }))
      if (claims.length > 0) {
        doc.draft = { ...doc.draft, mergedClaims: claims }
      }
    }
  }

  if (doc.graphType === 'verify' && doc.draft && 'claimId' in doc.draft) {
    const claimId = doc.draft.claimId
    const routes = doc.nodes
      .filter((n): n is MapSubAgentNode => n.kind === 'subAgent' && n.parentId === claimId)
      .map(n => ({ ...n.params }))
    doc.draft = { ...doc.draft, routeInstructions: routes }
  }
}

export function docDeleteFocus(doc: MapGraphDoc): void {
  doc.activeNodeId = undefined
  doc.pendingTool = undefined
  doc.nextNode = undefined
  docDeleteRuntime(doc)
}

// —— internals ——

export function docDeleteNodes(doc: MapGraphDoc, ids: Set<string>): void {
  if (ids.size === 0) return
  doc.nodes = doc.nodes.filter(n => !ids.has(n.id))
  doc.edges = doc.edges.filter(e => !ids.has(e.from) && !ids.has(e.to))
}

function docReadDraftClaims(doc: MapGraphDoc): MapClaimNode[] {
  return doc.nodes
    .filter((n): n is MapClaimNode => n.kind === 'claim' && mapIdIsDraftClaim(n.id))
    .sort((a, b) => (mapIdReadDraftIndex(a.id) ?? 0) - (mapIdReadDraftIndex(b.id) ?? 0))
}

function docUpdateSplitRoutes(
  doc: MapGraphDoc,
  routes: MapSubAgentParams[],
  parentId = NEWS_ROOT_ID,
): void {
  for (const route of routes) {
    docUpdateSubAgent(doc, parentId, route)
  }
}

type VerifyOpinionLike = {
  agentName: string
  instanceId: string
  priority: Priority
  reason: string
  score: MapOpinionNode['params']['confidence']
}

function docUpdateVerifyOpinions(
  doc: MapGraphDoc,
  claimId: string,
  routes: MapSubAgentParams[],
  opinions: VerifyOpinionLike[],
  opinionSaveIndex: number,
): void {
  const usedParents = new Set<string>()
  opinions.forEach((op, index) => {
    const route = routes.length > 0
      ? docReadOpinionRoute(routes, op, usedParents)
      : { agentName: op.agentName, priority: op.priority, instanceId: op.instanceId }
    const parentId = docUpdateSubAgent(doc, claimId, route)
    usedParents.add(route.instanceId)
    const persisted = index < opinionSaveIndex
    docUpdateOpinion(doc, {
      id: mapIdCreateOpinion(claimId, index),
      parentId,
      content: op.reason,
      confidence: op.score,
      priority: op.priority,
      dataPhase: persisted ? 'persisted' : 'workerOut',
    })
  })
}

function docDeleteRunSession(doc: MapGraphDoc): void {
  doc.runPhase = 'idle'
  doc.activeNodeId = undefined
  doc.pendingTool = undefined
  doc.nextNode = undefined
  doc.runId = undefined
  doc.threadId = undefined
  doc.graphType = undefined
  doc.draft = undefined
  doc.error = undefined
}

function docDeleteSkill(node: MapNode): void {
  if (!node.runtime?.activeSkill) return
  const { activeSkill: _drop, ...rest } = node.runtime
  node.runtime = Object.keys(rest).length > 0 ? rest : undefined
}

function docDeleteRuntime(doc: MapGraphDoc): void {
  for (const n of doc.nodes) {
    if (n.runtime) delete n.runtime
  }
}

/** 清除 HITL runtime 标记，保留各节点 activeSkill（并行 SubAgent 调工具时）。 */
function docDeleteHitlRuntime(doc: MapGraphDoc): void {
  for (const n of doc.nodes) {
    if (!n.runtime) continue
    const { activeSkill } = n.runtime
    if (activeSkill) {
      n.runtime = { activeSkill }
    } else {
      delete n.runtime
    }
  }
}

function docDeleteSubAgentSkill(doc: MapGraphDoc): void {
  for (const n of doc.nodes) {
    if (n.kind !== 'subAgent') continue
    docDeleteSkill(n)
  }
}

function docUpdateFocus(doc: MapGraphDoc): void {
  docDeleteRuntime(doc)
  const id = doc.activeNodeId
  const tool = doc.pendingTool
  if (!id || !tool) return
  const node = doc.nodes.find(n => n.id === id)
  if (!node) return
  if (doc.runPhase === 'interrupted') {
    node.runtime = { pendingTool: tool }
  } else if (doc.runPhase === 'running') {
    node.runtime = { activeTool: tool }
  }
}

function docUpdateNews(doc: MapGraphDoc, content: string): void {
  const existing = doc.nodes.find((n): n is MapNewsNode => n.kind === 'news')
  if (existing) {
    existing.params = { content }
    return
  }
  doc.nodes.push({
    id: NEWS_ROOT_ID,
    kind: 'news',
    params: { content },
  })
}

export function docUpdateSubAgent(
  doc: MapGraphDoc,
  parentId: string,
  route: MapSubAgentParams,
): string {
  const id = mapIdCreateRoute(route)
  const existing = doc.nodes.find((n): n is MapSubAgentNode => n.id === id)
  if (existing) {
    const prevParent = existing.parentId
    existing.params = route
    existing.parentId = parentId
    if (prevParent && prevParent !== parentId) {
      doc.edges = doc.edges.filter(e => !(e.to === id && e.from === prevParent))
    }
    docUpdateEdge(doc, parentId, id)
    return id
  }
  const node: MapSubAgentNode = {
    id,
    kind: 'subAgent',
    parentId,
    params: route,
  }
  doc.nodes.push(node)
  docUpdateEdge(doc, parentId, id)
  return id
}

/** 将 opinion 挂到对应核查槽（按 instanceId）。 */
function docReadOpinionRoute(
  routes: MapSubAgentParams[],
  op: { agentName: string; instanceId: string; priority: Priority },
  used: Set<string>,
): MapSubAgentParams {
  const byId = routes.find(r => r.instanceId === op.instanceId && !used.has(r.instanceId))
  if (byId) return byId
  return {
    agentName: op.agentName,
    priority: op.priority,
    instanceId: op.instanceId,
  }
}

function docUpdateClaim(
  doc: MapGraphDoc,
  opts: {
    id: string
    parentId: string
    content: string
    category?: string
    sourceAgent?: string
    dataPhase: MapClaimNode['dataPhase']
    shouldSave?: boolean
  },
): void {
  const shouldSave = opts.shouldSave ?? true
  const existing = doc.nodes.find((n): n is MapClaimNode => n.id === opts.id)
  if (existing) {
    existing.parentId = opts.parentId
    existing.params = {
      content: opts.content,
      category: opts.category,
      sourceAgent: opts.sourceAgent,
    }
    existing.dataPhase = opts.dataPhase
    existing.shouldSave = shouldSave
    docUpdateEdge(doc, opts.parentId, opts.id)
    return
  }
  doc.nodes.push({
    id: opts.id,
    kind: 'claim',
    parentId: opts.parentId,
    params: {
      content: opts.content,
      category: opts.category,
      sourceAgent: opts.sourceAgent,
    },
    dataPhase: opts.dataPhase,
    shouldSave,
  })
  docUpdateEdge(doc, opts.parentId, opts.id)
}

function docUpdateOpinion(
  doc: MapGraphDoc,
  opts: {
    id: string
    parentId: string
    content: string
    confidence: MapOpinionNode['params']['confidence']
    priority: Priority
    dataPhase: MapOpinionNode['dataPhase']
  },
): void {
  const existing = doc.nodes.find((n): n is MapOpinionNode => n.id === opts.id)
  if (existing) {
    existing.parentId = opts.parentId
    existing.params = {
      content: opts.content,
      confidence: opts.confidence,
      priority: opts.priority,
    }
    existing.dataPhase = opts.dataPhase
    docUpdateEdge(doc, opts.parentId, opts.id)
    return
  }
  doc.nodes.push({
    id: opts.id,
    kind: 'opinion',
    parentId: opts.parentId,
    params: {
      content: opts.content,
      confidence: opts.confidence,
      priority: opts.priority,
    },
    dataPhase: opts.dataPhase,
  })
  docUpdateEdge(doc, opts.parentId, opts.id)
}

function docUpdateEdge(doc: MapGraphDoc, from: string, to: string): void {
  const id = mapIdCreateEdge(from, to)
  if (doc.edges.some(e => e.id === id)) return
  doc.edges.push({ id, from, to })
}

function docReadClaimParent(
  nodes: MapNode[],
  source: { instanceId?: string; agentName?: string },
  splitRoutes: MapSubAgentParams[],
): string {
  if (!source.instanceId) return NEWS_ROOT_ID
  const route = splitRoutes.find(r => r.instanceId === source.instanceId)
  if (route) {
    const id = mapIdCreateRoute(route)
    if (nodes.some(n => n.id === id)) return id
  }
  const byId = nodes.find(
    n => n.kind === 'subAgent' && n.params.instanceId === source.instanceId,
  )
  return byId?.id ?? NEWS_ROOT_ID
}

function docUpdateDraftClaims(doc: MapGraphDoc, state: GraphSplitState): void {
  const routes = state.routeInstructions ?? []
  let draftSeq = 0
  for (const result of state.subAgentResults ?? []) {
    const parentId = docReadClaimParent(
      doc.nodes,
      { instanceId: result.instanceId, agentName: result.agentName },
      routes,
    )
    for (const c of result.claims) {
      docUpdateClaim(doc, {
        id: mapIdCreateDraftClaim(draftSeq++),
        parentId,
        content: c.content,
        category: c.category,
        sourceAgent: c.sourceAgent ?? result.agentName,
        dataPhase: 'workerOut',
        shouldSave: true,
      })
    }
  }
}

/** 按草稿下标只更新 shouldSave，不改 content / parent。 */
function docUpdateSaveFlags(doc: MapGraphDoc, state: GraphSplitState): void {
  const drafts = docReadDraftClaims(doc)

  if (drafts.length === 0 || !state.mergedClaims?.length) return

  if (state.mergedClaims.length === drafts.length) {
    drafts.forEach((d, i) => {
      d.shouldSave = state.mergedClaims[i].shouldSave !== false
    })
    return
  }

  // 带 draftIndex 的稀疏更新
  for (const c of state.mergedClaims) {
    const idx = (c as { draftIndex?: number }).draftIndex
    if (typeof idx === 'number' && drafts[idx]) {
      drafts[idx].shouldSave = c.shouldSave !== false
    }
  }
}

function docUpdateSplitState(doc: MapGraphDoc, state: GraphSplitState): void {
  const routes = state.routeInstructions ?? []
  docUpdateSplitRoutes(doc, routes)

  // validate：草稿 + merge 标记；save：已剪枝的 numbered claims
  if (doc.pendingTool === 'validate') {
    docUpdateDraftClaims(doc, state)
    docUpdateSaveFlags(doc, state)
    return
  }

  if (state.mergedClaims?.length && (doc.pendingTool === 'save' || state.saveIndex > 0)) {
    state.mergedClaims.forEach((c, index) => {
      const id = mapIdCreateClaim(index)
      const persisted = index < state.saveIndex
      const parentId = docReadClaimParent(doc.nodes, { agentName: c.sourceAgent }, routes)
      docUpdateClaim(doc, {
        id,
        parentId,
        content: c.content,
        category: c.category,
        sourceAgent: c.sourceAgent,
        dataPhase: persisted ? 'persisted' : 'workerOut',
        shouldSave: true,
      })
    })
    return
  }

  // confirmRoute 或仅有 subAgentResults（尚无 merge）
  if (state.subAgentResults?.length && !state.mergedClaims?.length) {
    docUpdateDraftClaims(doc, state)
  }
}

function docUpdateVerifyState(doc: MapGraphDoc, state: GraphVerifyState): void {
  const claimId = state.claimId
  const existingClaim = doc.nodes.find((n): n is MapClaimNode => n.id === claimId)
  if (existingClaim) {
    existingClaim.params = {
      ...existingClaim.params,
      content: state.claimContent || existingClaim.params.content,
    }
    existingClaim.dataPhase = 'persisted'
    existingClaim.shouldSave = true
  } else {
    docUpdateClaim(doc, {
      id: claimId,
      parentId: NEWS_ROOT_ID,
      content: state.claimContent,
      dataPhase: 'persisted',
      shouldSave: true,
    })
  }

  const routes = state.routeInstructions ?? []
  const routeNodeIds = new Set(routes.map(r => mapIdCreateRoute(r)))
  const staleIds = new Set(
    doc.nodes
      .filter(n => n.kind === 'subAgent' && n.parentId === claimId && !routeNodeIds.has(n.id))
      .map(n => n.id),
  )
  for (const n of doc.nodes) {
    if (n.parentId && staleIds.has(n.parentId)) staleIds.add(n.id)
  }
  docDeleteNodes(doc, staleIds)

  docUpdateSplitRoutes(doc, routes, claimId)
  docUpdateVerifyOpinions(
    doc,
    claimId,
    routes,
    state.subAgentOpinions,
    state.opinionSaveIndex,
  )
}

// —— 快照能力判定（纯函数，不改图）——

/**
 * 参数是否已锁定（不可再编辑）。
 * 规则：
 *   - runPhase 为 running 时全部锁
 *   - claim 一旦进入 persisted 就锁；opinion 始终只读
 *   - subAgent 只要有已产出的下游 claim/opinion（任何 dataPhase）就锁
 *   - news：idle 可改正文；一旦进入流程（非 idle）即锁，保证 loadNews 读的是已编辑正文
 */
export function docIsParamsLocked(snapshot: MapSnapshot, node: MapNode): boolean {
  if (snapshot.runPhase === 'running') return true

  if (node.kind === 'opinion') return true

  if (node.kind === 'claim') {
    return node.dataPhase !== 'workerOut'
  }

  if (node.kind === 'news') {
    return snapshot.runPhase !== 'idle'
  }

  const hasChildOutput = snapshot.nodes.some(
    n => n.parentId === node.id && (n.kind === 'claim' || n.kind === 'opinion'),
  )
  return hasChildOutput
}

/**
 * 能否在 parentNodeId 下新增 SubAgent。
 *   - 拆分/核查槽：仅 AI route 之后、invoke 确认前（interrupted + pendingTool=invoke）
 *   - idle 只编辑正文，不预置槽
 *   - runPhase === 'running' 时一律禁止
 */
export function docCanAddSubAgent(snapshot: MapSnapshot, parentNodeId: string): boolean {
  if (snapshot.runPhase === 'running') return false

  const configuring =
    snapshot.runPhase === 'interrupted' && snapshot.pendingTool === 'invoke'
  if (!configuring) return false

  if (parentNodeId === NEWS_ROOT_ID) return true

  const parent = snapshot.nodes.find(n => n.id === parentNodeId)
  if (parent?.kind === 'claim' && parent.dataPhase === 'persisted') return true
  return false
}

/** 能否编辑节点参数。 */
export function docCanEditNode(snapshot: MapSnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node) return false
  return !docIsParamsLocked(snapshot, node)
}

/**
 * 能否手动移除节点（仅空 SubAgent 槽）。
 * 仅 invoke 配置期（confirmRoute）允许；idle / running / 其它中断 / completed / error 禁止。
 */
export function docCanRemoveNode(snapshot: MapSnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node || node.kind !== 'subAgent') return false
  if (snapshot.runPhase !== 'interrupted' || snapshot.pendingTool !== 'invoke') {
    return false
  }
  return !docReadDescendants(snapshot, nodeId)
}

function docReadDescendants(snapshot: MapSnapshot, nodeId: string): boolean {
  return snapshot.nodes.some(n => n.parentId === nodeId)
}
