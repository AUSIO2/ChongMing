/**
 * Map 层内存图：按 newsId 维护一张可变图，整合 LangGraph 事件与人的 CRUD。
 * 含快照上的能力判定（锁 / canAdd / canEdit / canRemove）。
 */
import {
  NEWS_ROOT_ID,
  edgeId,
  mergedClaimNodeId,
  opinionNodeId,
  routeInstanceId,
  routeNodeId,
  scopedVerifyInstanceId,
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
  canWriteRouteInstructions,
  type DisplayNews,
  type GraphInterruptedPayload,
  type GraphSplitState,
  type GraphStatePatch,
  type GraphType,
  type GraphVerifyState,
} from '../../electron/api/types'

export interface MapGraphDoc {
  newsId: string
  nodes: MapNode[]
  edges: MapEdge[]
  runPhase: MapRunPhase
  mode: ExecutionMode
  activeNodeId?: string
  pendingTool?: MapToolKind
  runId?: string
  graphType?: GraphType
  draft?: GraphSplitState | GraphVerifyState
  error?: string
}

export function toSnapshot(doc: MapGraphDoc): MapSnapshot {
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

export function createEmptyDoc(newsId: string, mode: ExecutionMode = 'human-in-loop'): MapGraphDoc {
  return {
    newsId,
    nodes: [],
    edges: [],
    runPhase: 'idle',
    mode,
  }
}

/** 从 DB 新闻构建 idle 图（新闻 + 拆分槽历史 + claim/opinion）。 */
export function bootstrapFromNews(
  news: DisplayNews,
  mode: ExecutionMode = 'human-in-loop',
): MapGraphDoc {
  const doc = createEmptyDoc(news._id, mode)
  upsertNews(doc, news.content)

  const splitRoutes = resolveSplitRoutesFromNews(news)
  for (const route of splitRoutes) {
    ensureSubAgent(doc, NEWS_ROOT_ID, route)
  }

  for (const c of news.claims) {
    const claimParent = resolveClaimParent(doc.nodes, c.sourceAgent, splitRoutes)
    upsertClaim(doc, {
      id: c.claimId,
      parentId: claimParent,
      content: c.content,
      category: c.category,
      sourceAgent: c.sourceAgent,
      dataPhase: 'persisted',
      shouldSave: true,
    })

    const opinions = c.verifyResult?.opinions ?? []
    const agentSeq = new Map<string, number>()
    opinions.forEach((op, index) => {
      const seq = (agentSeq.get(op.agentName) ?? 0) + 1
      agentSeq.set(op.agentName, seq)
      const route: MapSubAgentParams = {
        agentName: op.agentName,
        priority: op.priority,
        instanceId: scopedVerifyInstanceId(c.claimId, {
          agentName: op.agentName,
          instanceId: op.instanceId
            ?? (seq <= 1 ? op.agentName : `${op.agentName}#${seq}`),
        }),
      }
      ensureSubAgent(doc, c.claimId, route)
      upsertOpinion(doc, {
        id: opinionNodeId(c.claimId, index),
        parentId: routeNodeId(route),
        content: op.reason,
        confidence: op.score,
        priority: op.priority,
        dataPhase: 'persisted',
      })
    })
  }

  doc.runPhase = 'idle'
  doc.error = undefined
  clearFocus(doc)
  return doc
}

/** 从 splitMeta / claims 还原拆分槽位历史。 */
function resolveSplitRoutesFromNews(news: DisplayNews): MapSubAgentParams[] {
  const meta = news.splitMeta
  if (meta?.routeInstructions?.length) {
    return meta.routeInstructions.map(r => ({
      agentName: r.agentName,
      priority: r.priority,
      hint: r.hint,
      instanceId: r.instanceId ?? r.agentName,
    }))
  }

  const seen = new Set<string>()
  const routes: MapSubAgentParams[] = []

  for (const r of meta?.subAgentResults ?? []) {
    const instanceId = r.instanceId ?? r.agentName
    if (seen.has(instanceId)) continue
    seen.add(instanceId)
    routes.push({
      agentName: r.agentName,
      priority: r.priority,
      instanceId,
    })
  }

  if (routes.length === 0) {
    for (const c of news.claims) {
      const name = c.sourceAgent
      if (!name || name === 'merge' || name === 'fallback' || seen.has(name)) continue
      seen.add(name)
      routes.push({ agentName: name, priority: 'medium', instanceId: name })
    }
  }

  return routes
}

export function applyProgress(doc: MapGraphDoc, runId: string, graphType: GraphType): void {
  if (doc.runPhase === 'error' || doc.runPhase === 'completed') return
  const focusId = doc.activeNodeId
  const tool = doc.pendingTool
  doc.runId = runId
  doc.graphType = graphType
  doc.runPhase = 'running'
  doc.pendingTool = undefined
  clearNodeRuntimes(doc)
  if (focusId && tool) {
    doc.activeNodeId = focusId
    const node = doc.nodes.find(n => n.id === focusId)
    if (node) node.runtime = { activeTool: tool }
  } else {
    doc.activeNodeId = undefined
  }
}

export function applyError(doc: MapGraphDoc, message: string): void {
  doc.runPhase = 'error'
  doc.error = message
  clearFocus(doc)
}

export function applyInterrupted(doc: MapGraphDoc, payload: GraphInterruptedPayload): void {
  doc.error = undefined
  doc.runPhase = 'interrupted'
  doc.mode = payload.mode
  doc.runId = payload.runId
  doc.graphType = payload.graphType
  doc.pendingTool = payload.pendingTool
  doc.activeNodeId = payload.focus?.id
  doc.draft = payload.state

  if (payload.graphType === 'split') {
    const newsContent =
      'content' in payload.state && typeof payload.state.content === 'string'
        ? payload.state.content
        : (doc.nodes.find(n => n.kind === 'news') as MapNewsNode | undefined)?.params.content
          ?? ''
    doc.nodes = []
    doc.edges = []
    upsertNews(doc, newsContent)
    applySplitState(doc, payload.state as GraphSplitState)
  } else {
    markClaimsPersisted(doc)
    applyVerifyState(doc, payload.state as GraphVerifyState)
  }

  attachFocus(doc)
}

/** split 完成进入 verify：不读 DB，只整理内存图运行态。 */
export function prepareForVerify(doc: MapGraphDoc): void {
  markClaimsPersisted(doc)
  const removed = new Set(
    doc.nodes.filter(n => n.kind === 'claim' && n.id.startsWith('draft:')).map(n => n.id),
  )
  if (removed.size > 0) {
    doc.nodes = doc.nodes.filter(n => !removed.has(n.id))
    doc.edges = doc.edges.filter(e => !removed.has(e.from) && !removed.has(e.to))
  }
  doc.draft = undefined
  doc.error = undefined
  doc.runPhase = 'running'
  clearFocus(doc)
}

export function markRunCompleted(doc: MapGraphDoc): void {
  markClaimsPersisted(doc)
  doc.runPhase = 'completed'
  doc.runId = undefined
  doc.graphType = undefined
  doc.draft = undefined
  doc.error = undefined
  clearFocus(doc)
}

/** 用 DB 新闻重建 idle 图，清空运行态字段。 */
export function resetIdleFromNews(doc: MapGraphDoc, news: DisplayNews): void {
  const mode = doc.mode
  const next = bootstrapFromNews(news, mode)
  doc.newsId = next.newsId
  doc.nodes = next.nodes
  doc.edges = next.edges
  doc.runPhase = 'idle'
  doc.mode = mode
  doc.activeNodeId = undefined
  doc.pendingTool = undefined
  doc.runId = undefined
  doc.graphType = undefined
  doc.draft = undefined
  doc.error = undefined
}

function markClaimsPersisted(doc: MapGraphDoc): void {
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
export function pruneRejectedClaims(doc: MapGraphDoc): void {
  const removed = new Set(
    doc.nodes
      .filter((n): n is MapClaimNode => n.kind === 'claim' && !n.shouldSave)
      .map(n => n.id),
  )
  if (removed.size === 0) return
  doc.nodes = doc.nodes.filter(n => !removed.has(n.id))
  doc.edges = doc.edges.filter(e => !removed.has(e.from) && !removed.has(e.to))
}

export function buildResumePatch(doc: MapGraphDoc): GraphStatePatch {
  const state = doc.draft
  if (!state) return null

  if (canWriteRouteInstructions(doc.pendingTool) && 'routeInstructions' in state) {
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
export function syncDraftFromNodes(doc: MapGraphDoc): void {
  if (!doc.draft) return

  if (doc.graphType === 'split' && 'routeInstructions' in doc.draft) {
    const routes = doc.nodes
      .filter((n): n is MapSubAgentNode => n.kind === 'subAgent' && n.parentId === NEWS_ROOT_ID)
      .map(n => ({ ...n.params }))
    doc.draft = { ...doc.draft, routeInstructions: routes }

    if ('mergedClaims' in doc.draft) {
      const numbered = doc.nodes
        .filter((n): n is MapClaimNode => n.kind === 'claim' && !n.id.startsWith('draft:'))
        .sort((a, b) => Number(a.id) - Number(b.id))

      const source = numbered.length > 0
        ? numbered
        : doc.nodes
          .filter((n): n is MapClaimNode =>
            n.kind === 'claim' && n.id.startsWith('draft:') && n.shouldSave,
          )
          .sort((a, b) => Number(a.id.slice('draft:'.length)) - Number(b.id.slice('draft:'.length)))

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

export function clearFocus(doc: MapGraphDoc): void {
  doc.activeNodeId = undefined
  doc.pendingTool = undefined
  clearNodeRuntimes(doc)
}

// —— internals ——

function clearNodeRuntimes(doc: MapGraphDoc): void {
  for (const n of doc.nodes) {
    if (n.runtime) delete n.runtime
  }
}

function attachFocus(doc: MapGraphDoc): void {
  clearNodeRuntimes(doc)
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

function upsertNews(doc: MapGraphDoc, content: string): void {
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

export function ensureSubAgent(
  doc: MapGraphDoc,
  parentId: string,
  route: MapSubAgentParams,
): string {
  const params: MapSubAgentParams = {
    ...route,
    instanceId: routeInstanceId(route),
  }
  const id = routeNodeId(params)
  const existing = doc.nodes.find((n): n is MapSubAgentNode => n.id === id)
  if (existing) {
    const prevParent = existing.parentId
    existing.params = params
    existing.parentId = parentId
    if (prevParent && prevParent !== parentId) {
      doc.edges = doc.edges.filter(e => !(e.to === id && e.from === prevParent))
    }
    ensureEdge(doc, parentId, id)
    return id
  }
  const node: MapSubAgentNode = {
    id,
    kind: 'subAgent',
    parentId,
    params,
  }
  doc.nodes.push(node)
  ensureEdge(doc, parentId, id)
  return id
}

/**
 * 核查槽 instanceId：加 claimId 前缀防跨 claim 碰撞；
 * 保留 route 自带后缀（agentName#2），允许同名多槽。
 */
function scopedVerifyRoute(claimId: string, route: MapSubAgentParams): MapSubAgentParams {
  return {
    ...route,
    instanceId: scopedVerifyInstanceId(claimId, route),
  }
}

/** 将 opinion 挂到对应核查槽；同名多槽按 instanceId，否则按 agentName 顺序消费。 */
function resolveOpinionParentRoute(
  routes: MapSubAgentParams[],
  claimId: string,
  op: { agentName: string; instanceId?: string; priority: Priority },
  used: Set<string>,
): MapSubAgentParams {
  if (op.instanceId) {
    const want = scopedVerifyInstanceId(claimId, {
      agentName: op.agentName,
      instanceId: op.instanceId,
    })
    const byId = routes.find(r => routeInstanceId(r) === want && !used.has(routeInstanceId(r)))
    if (byId) return byId
  }
  const byName = routes.find(
    r => r.agentName === op.agentName && !used.has(routeInstanceId(r)),
  )
  if (byName) return byName
  return scopedVerifyRoute(claimId, {
    agentName: op.agentName,
    priority: op.priority,
    instanceId: op.instanceId,
  })
}

function upsertClaim(
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
    ensureEdge(doc, opts.parentId, opts.id)
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
  ensureEdge(doc, opts.parentId, opts.id)
}

function upsertOpinion(
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
    ensureEdge(doc, opts.parentId, opts.id)
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
  ensureEdge(doc, opts.parentId, opts.id)
}

function ensureEdge(doc: MapGraphDoc, from: string, to: string): void {
  const id = edgeId(from, to)
  if (doc.edges.some(e => e.id === id)) return
  doc.edges.push({ id, from, to })
}

function resolveClaimParent(
  nodes: MapNode[],
  sourceAgent: string | undefined,
  splitRoutes: MapSubAgentParams[],
): string {
  const source = sourceAgent?.trim()
  if (source && source !== 'merge' && source !== 'fallback') {
    const route = splitRoutes.find(r => r.agentName === source)
    if (route) {
      const id = routeNodeId(route)
      if (nodes.some(n => n.id === id)) return id
    }
    const byName = nodes.find(
      n => n.kind === 'subAgent' && n.params.agentName === source,
    )
    if (byName) return byName.id
  }
  const firstSub = nodes.find(n => n.kind === 'subAgent' && n.parentId === NEWS_ROOT_ID)
  return firstSub?.id ?? NEWS_ROOT_ID
}

function materializeDraftClaims(doc: MapGraphDoc, state: GraphSplitState): void {
  const routes = state.routeInstructions ?? []
  let draftSeq = 0
  for (const result of state.subAgentResults ?? []) {
    const parentId = resolveClaimParent(doc.nodes, result.agentName, routes)
    for (const c of result.claims) {
      upsertClaim(doc, {
        id: `draft:${draftSeq++}`,
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
function applyShouldSaveFlags(doc: MapGraphDoc, state: GraphSplitState): void {
  const drafts = doc.nodes
    .filter((n): n is MapClaimNode => n.kind === 'claim' && n.id.startsWith('draft:'))
    .sort((a, b) => Number(a.id.slice('draft:'.length)) - Number(b.id.slice('draft:'.length)))

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

function applySplitState(doc: MapGraphDoc, state: GraphSplitState): void {
  const routes = state.routeInstructions ?? []
  for (const route of routes) {
    ensureSubAgent(doc, NEWS_ROOT_ID, route)
  }

  // validate：草稿 + merge 标记；save：已剪枝的 numbered claims
  if (doc.pendingTool === 'validate') {
    materializeDraftClaims(doc, state)
    applyShouldSaveFlags(doc, state)
    return
  }

  if (state.mergedClaims?.length && (doc.pendingTool === 'save' || state.saveIndex > 0)) {
    state.mergedClaims.forEach((c, index) => {
      const id = mergedClaimNodeId(index)
      const persisted = index < state.saveIndex
      const parentId = resolveClaimParent(doc.nodes, c.sourceAgent, routes)
      upsertClaim(doc, {
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
    materializeDraftClaims(doc, state)
  }
}

function applyVerifyState(doc: MapGraphDoc, state: GraphVerifyState): void {
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
    upsertClaim(doc, {
      id: claimId,
      parentId: NEWS_ROOT_ID,
      content: state.claimContent,
      dataPhase: 'persisted',
      shouldSave: true,
    })
  }

  const routes = (state.routeInstructions ?? []).map(r => scopedVerifyRoute(claimId, r))
  const routeNodeIds = new Set(routes.map(r => routeNodeId(r)))
  // 去掉本 claim 下不在当前 route 中的旧槽（例如未加 claimId 前缀的历史节点）
  const staleIds = new Set(
    doc.nodes
      .filter(n => n.kind === 'subAgent' && n.parentId === claimId && !routeNodeIds.has(n.id))
      .map(n => n.id),
  )
  for (const n of doc.nodes) {
    if (n.parentId && staleIds.has(n.parentId)) staleIds.add(n.id)
  }
  if (staleIds.size > 0) {
    doc.nodes = doc.nodes.filter(n => !staleIds.has(n.id))
    doc.edges = doc.edges.filter(e => !staleIds.has(e.from) && !staleIds.has(e.to))
  }

  for (const route of routes) {
    ensureSubAgent(doc, claimId, route)
  }

  const usedParents = new Set<string>()
  state.subAgentOpinions.forEach((op, index) => {
    const route = resolveOpinionParentRoute(routes, claimId, op, usedParents)
    const parentId = ensureSubAgent(doc, claimId, route)
    usedParents.add(routeInstanceId(route))
    const persisted = index < state.opinionSaveIndex
    upsertOpinion(doc, {
      id: opinionNodeId(claimId, index),
      parentId,
      content: op.reason,
      confidence: op.score,
      priority: op.priority,
      dataPhase: persisted ? 'persisted' : 'workerOut',
    })
  })
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
export function isParamsLocked(snapshot: MapSnapshot, node: MapNode): boolean {
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
export function canAddSubAgent(snapshot: MapSnapshot, parentNodeId: string): boolean {
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
export function canEditNode(snapshot: MapSnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node) return false
  return !isParamsLocked(snapshot, node)
}

/**
 * 能否手动移除节点（仅空 SubAgent 槽）。
 * 仅 invoke 配置期（confirmRoute）允许；idle / running / 其它中断 / completed / error 禁止。
 */
export function canRemoveNode(snapshot: MapSnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node || node.kind !== 'subAgent') return false
  if (snapshot.runPhase !== 'interrupted' || snapshot.pendingTool !== 'invoke') {
    return false
  }
  return !hasDescendants(snapshot, nodeId)
}

function hasDescendants(snapshot: MapSnapshot, nodeId: string): boolean {
  return snapshot.nodes.some(n => n.parentId === nodeId)
}
