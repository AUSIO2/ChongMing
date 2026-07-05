/**
 * Map 层内存图：按 mapId 维护一张可变图，整合 LangGraph 事件与人的 CRUD。
 * 含快照上的能力判定（锁 / canAdd / canEdit / canRemove）。
 */
import {
  MAP_DEFAULT_NEWS_ID,
  mapIdReadDraftIndex,
  mapIdCreateDraftClaim,
  mapIdCreateEdge,
  mapIdIsDraftClaim,
  mapIdCreateClaim,
  mapIdCreateOpinion,
  mapIdReadSubAgent,
  mapIdCreateRoute,
  mapIdReadSubAgentClaim,
  mapIdCreateChain,
  mapIdCreateSource,
  mapIdCreateParse,
  mapIdCreateNews,
  mapIdReadChain,
  mapIdIsScopedNews,
} from './ids'
import { mergeUpdateDraftFlags } from '../../electron/shared/merge-flags'
import type {
  ExecutionMode,
  MapClaimNode,
  MapEdge,
  MapNode,
  MapNodeKind,
  MapNewsNode,
  MapOpinionNode,
  MapParseAgentNode,
  MapRunPhase,
  MapSnapshot,
  MapSourceNode,
  MapSubAgentNode,
  MapSubAgentParams,
  MapToolKind,
  Priority,
} from './types'
import {
  timelineCreateDefault,
  type MapTimeline,
} from './timeline'
import { layoutReadNodeColumn } from './columns'
import {
  apiCanWriteRoute,
  type DisplayMap,
  type GraphInterruptNode,
  type GraphInterruptedPayload,
  type GraphProgressPayload,
  type GraphSplitState,
  type GraphStatePatch,
  type TransitionKey,
  type GraphParseState,
  type GraphVerifyState,
  type MapGraphPersist,
  type MapRunPersist,
} from '../../electron/api/types'

export interface MapGraphDoc {
  mapId: string
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
  transitionKey?: TransitionKey
  parentNodeId?: string
  draft?: GraphSplitState | GraphVerifyState | GraphParseState
  error?: string
  timeline: MapTimeline
}

export function docReadSnapshot(doc: MapGraphDoc): MapSnapshot {
  return {
    mapId: doc.mapId,
    nodes: doc.nodes.map(n => ({ ...n, params: { ...n.params } }) as MapNode),
    edges: doc.edges.map(e => ({ ...e })),
    runPhase: doc.runPhase,
    mode: doc.mode,
    activeNodeId: doc.activeNodeId,
    pendingTool: doc.pendingTool,
    error: doc.error,
    timeline: doc.timeline,
  }
}

export function docCreate(mapId: string, mode: ExecutionMode = 'human-in-loop'): MapGraphDoc {
  return {
    mapId,
    nodes: [],
    edges: [],
    runPhase: 'idle',
    mode,
    timeline: timelineCreateDefault(),
  }
}

/** 从 DB 新闻构建 idle 图（新闻 + 拆分槽历史 + claim/opinion）。 */
export function docCreateMap(
  news: DisplayMap,
  mode: ExecutionMode = 'human-in-loop',
): MapGraphDoc {
  const doc = docCreate(news._id, mode)
  doc.timeline = news.timeline
    ? { ...news.timeline }
    : timelineCreateDefault(news.content?.trim() ? MAP_DEFAULT_NEWS_ID : '')
  if (news.content?.trim()) {
    docUpdateMap(doc, news.content)
  }

  const splitRoutes = docReadMapRoutes(news)
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

/** 追加源节点；parse / news 在 0-1 路由投影时出现。 */
export function docAddSourceChain(
  doc: MapGraphDoc,
  input: {
    uri: string
    kind?: 'file' | 'url'
    label?: string
    chainId?: string
  },
): { sourceId: string; chainId: string } {
  const chainId = input.chainId ?? mapIdCreateChain()
  const sourceId = mapIdCreateSource(chainId)

  const sourceNode: MapSourceNode = {
    id: sourceId,
    kind: 'source',
    params: {
      uri: input.uri,
      kind: input.kind ?? 'file',
      label: input.label,
    },
  }

  doc.nodes.push(sourceNode)
  return { sourceId, chainId }
}

/** 追加独立新闻根（scoped news，无 parentId）。 */
export function docAddRootNews(
  doc: MapGraphDoc,
  content = '',
): string {
  const chainId = mapIdCreateChain()
  const newsId = mapIdCreateNews(chainId)
  doc.nodes.push({
    id: newsId,
    kind: 'news',
    params: { content },
  })
  return newsId
}

function docReadNextClaimId(doc: MapGraphDoc): string {
  let max = 0
  for (const n of doc.nodes) {
    if (n.kind !== 'claim' || mapIdIsDraftClaim(n.id)) continue
    const num = Number(n.id)
    if (Number.isFinite(num)) max = Math.max(max, num)
  }
  return mapIdCreateClaim(max)
}

/** 追加独立事实根（无 parentId）。 */
export function docAddRootClaim(
  doc: MapGraphDoc,
  content = '',
): string {
  const id = docReadNextClaimId(doc)
  doc.nodes.push({
    id,
    kind: 'claim',
    params: { content },
    dataPhase: 'workerOut',
    shouldSave: true,
  })
  return id
}

/** 查找首个待解析的 source 根（对应 news 正文仍为空）。 */
export function docReadPendingParseSource(
  doc: Pick<MapGraphDoc, 'nodes'>,
): string | undefined {
  for (const node of doc.nodes) {
    if (node.kind !== 'source' || node.parentId) continue
    const chainId = mapIdReadChain(node.id)
    if (!chainId) continue
    const newsId = mapIdCreateNews(chainId)
    const news = doc.nodes.find(
      (n): n is MapNewsNode => n.id === newsId && n.kind === 'news',
    )
    if (!news || !news.params.content.trim()) return node.id
  }
  return undefined
}

/** 从 splitMeta.routeInstructions 还原拆分槽位。 */
function docReadMapRoutes(news: DisplayMap): MapSubAgentParams[] {
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

  doc.transitionKey = payload.transitionKey

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
  const draft = doc.draft
  if (!draft || !('routeInstructions' in draft)) return undefined
  const parentId = 'scopeNodeId' in draft ? draft.parentNodeId : draft.parentNodeId
  return draft.routeInstructions?.find(r => mapIdCreateRoute(r, parentId) === nodeId)
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

function docUpdateFanoutParseAgent(
  doc: MapGraphDoc,
  payload: GraphFanoutSpawnPayload,
): void {
  const parentId = payload.parentNodeId
  if (!parentId) return
  const chainId = mapIdReadChain(parentId)
  if (!chainId) return
  const parseId = mapIdCreateParse(chainId)
  if (doc.nodes.some(n => n.id === parseId)) return

  const parseNode: MapParseAgentNode = {
    id: parseId,
    kind: 'parseAgent',
    parentId,
    params: { agentName: payload.agentName ?? 'parse' },
  }
  doc.nodes.push(parseNode)
  docUpdateEdge(doc, parentId, parseId)
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
    if (doc.transitionKey === '0-1') {
      docUpdateFanoutParseAgent(doc, payload as GraphFanoutSpawnPayload)
    } else {
      docUpdateFanoutSubAgent(doc, payload as GraphFanoutSpawnPayload)
    }
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
  doc.transitionKey = payload.transitionKey
  doc.nextNode = payload.nextNode
  doc.pendingTool = payload.pendingTool
  doc.activeNodeId = payload.focus?.id
  doc.draft = payload.state

  // invoke 重入时清旧拆分；validate/save 只投影 shouldSave，不能 prune（draft 常无 routeInstructions）
  if (payload.transitionKey === '1-2' && payload.nextNode === 'confirmRoute') {
    if (mapIdIsScopedNews(payload.parentNodeId)) {
      docPruneSplitUnder(doc, payload.parentNodeId)
    } else {
      const newsNode = doc.nodes.find(
        (n): n is MapNewsNode => n.id === MAP_DEFAULT_NEWS_ID && n.kind === 'news',
      )
      doc.nodes = newsNode ? [newsNode] : []
      doc.edges = []
    }
  }
  docProjectGraphState(doc, payload.transitionKey, payload.state, {
    upcomingGate: payload.nextNode,
  })

  docUpdateFocus(doc)
}

/**
 * 将 LangGraph checkpoint 投影到 Map 图。
 * 与 HITL 中断解耦：auto 模式在每个节点执行后也会调用（见 graphRunInterrupt.onStateProject）。
 */
export function docProjectGraphState(
  doc: MapGraphDoc,
  transitionKey: TransitionKey,
  state: GraphSplitState | GraphVerifyState | GraphParseState,
  ctx?: {
    /** interrupt 时：即将进入的门闩 */
    upcomingGate?: GraphInterruptNode
    /** 节点执行后：刚跑完的节点 */
    completedNode?: string
  },
): void {
  if (transitionKey === '0-1') {
    docProjectParseState(doc, state as GraphParseState)
    return
  }
  if (transitionKey === '1-2') {
    const splitState = state as GraphSplitState
    docUpdateMap(doc, splitState.content, splitState.parentNodeId)
    docProjectSplitState(doc, splitState, ctx)
    return
  }

  docUpdateClaimPersist(doc)
  docUpdateVerifyState(doc, state as GraphVerifyState)
}

function docProjectParseState(doc: MapGraphDoc, state: GraphParseState): void {
  const chainId = mapIdReadChain(state.newsNodeId) ?? mapIdReadChain(state.parentNodeId)
  if (!chainId) return

  const sourceId = mapIdCreateSource(chainId)
  const parseId = mapIdCreateParse(chainId)

  for (const route of state.routeInstructions ?? []) {
    if (!doc.nodes.some(n => n.id === parseId)) {
      const parseNode: MapParseAgentNode = {
        id: parseId,
        kind: 'parseAgent',
        parentId: sourceId,
        params: { agentName: route.agentName },
      }
      doc.nodes.push(parseNode)
      docUpdateEdge(doc, sourceId, parseId)
    }
  }

  if (!state.parsedContent.trim()) return

  const existing = doc.nodes.find(
    (n): n is MapNewsNode => n.id === state.newsNodeId && n.kind === 'news',
  )
  if (existing) {
    existing.params.content = state.parsedContent
    return
  }

  doc.nodes.push({
    id: state.newsNodeId,
    kind: 'news',
    parentId: parseId,
    params: { content: state.parsedContent },
  })
  docUpdateEdge(doc, parseId, state.newsNodeId)
}

function docProjectSplitState(
  doc: MapGraphDoc,
  state: GraphSplitState,
  ctx?: {
    upcomingGate?: GraphInterruptNode
    completedNode?: string
  },
): void {
  const parentId = state.parentNodeId
  const routes = state.routeInstructions ?? []
  docUpdateSplitRoutes(doc, routes, parentId)

  const useNumbered =
    ctx?.upcomingGate === 'save'
    || ctx?.completedNode === 'validate'
    || ctx?.completedNode === 'save'
    || (state.saveIndex > 0 && !!state.mergedClaims?.length)

  if (useNumbered && state.mergedClaims?.length) {
    docUpdateNumberedClaims(doc, state, routes)
    return
  }

  if (
    state.mergedClaims?.length
    || ctx?.upcomingGate === 'validate'
    || ctx?.completedNode === 'merge'
  ) {
    docUpdateDraftClaims(doc, state)
    docUpdateSaveFlags(doc, state)
    return
  }

  if (state.subAgentResults?.length) {
    docUpdateDraftClaims(doc, state)
  }
}

/** split 完成进入 verify：不读 DB，只整理内存图运行态。 */
export function docUpdateVerify(doc: MapGraphDoc): void {
  docUpdateClaimPersist(doc)
  docDeleteNodes(doc, new Set(docReadClaims(doc, 'draft').map(n => n.id)))
  doc.draft = undefined
  doc.error = undefined
  doc.runPhase = 'running'
  docDeleteFocus(doc)
}

export function docUpdateRunEnd(doc: MapGraphDoc): void {
  docUpdateClaimPersist(doc)
  doc.runPhase = 'idle'
  doc.runId = undefined
  doc.threadId = undefined
  doc.transitionKey = undefined
  doc.nextNode = undefined
  doc.draft = undefined
  doc.error = undefined
  docDeleteFocus(doc)
}

/** 从 News.mapGraph 恢复内存图 */
export function docCreatePersist(
  mapId: string,
  persist: MapGraphPersist,
  mapRun?: MapRunPersist,
): MapGraphDoc {
  return {
    mapId,
    nodes: (persist.nodes ?? []) as MapNode[],
    edges: (persist.edges ?? []) as MapEdge[],
    runPhase: (persist.runPhase as MapRunPhase) ?? 'idle',
    mode: persist.mode ?? 'human-in-loop',
    activeNodeId: persist.activeNodeId,
    pendingTool: persist.pendingTool,
    nextNode: persist.nextNode,
    transitionKey: persist.transitionKey,
    draft: persist.draft,
    error: persist.error,
    runId: mapRun?.runId,
    threadId: mapRun?.threadId,
    parentNodeId: mapRun?.parentNodeId,
    timeline: timelineCreateDefault(),
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
    transitionKey: doc.transitionKey,
    draft: doc.draft,
    error: doc.error,
    updatedAt: new Date().toISOString(),
  }
}

/** 序列化运行会话供写入 Map.mapRun */
export function docReadPersistRun(doc: MapGraphDoc): MapRunPersist | null {
  if (!doc.runId || !doc.threadId || !doc.transitionKey || !doc.parentNodeId) return null
  const status =
    doc.runPhase === 'error'
      ? 'error'
      : doc.runPhase === 'interrupted'
        ? 'interrupted'
        : doc.runPhase === 'running'
          ? 'running'
          : null
  if (!status) return null

  return {
    runId: doc.runId,
    threadId: doc.threadId,
    transitionKey: doc.transitionKey,
    parentNodeId: doc.parentNodeId,
    mode: doc.mode,
    gate: doc.nextNode,
    pendingTool: doc.pendingTool,
    activeNodeId: doc.activeNodeId,
    status,
    updatedAt: new Date().toISOString(),
  }
}

/** 用 DB 新闻重建 idle 图，清空运行态字段。 */
export function docResetMap(doc: MapGraphDoc, news: DisplayMap): void {
  const mode = doc.mode
  const next = docCreateMap(news, mode)
  doc.mapId = next.mapId
  doc.nodes = next.nodes
  doc.edges = next.edges
  doc.mode = mode
  doc.timeline = next.timeline
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

  if (doc.pendingTool === 'save' && 'parsedContent' in state) {
    return { parsedContent: state.parsedContent }
  }

  return null
}

/** 从图上 subAgent / claim 写回 draft，供 resume。 */
export function docUpdateDraft(doc: MapGraphDoc): void {
  if (!doc.draft) return

  if (doc.transitionKey === '1-2' && 'routeInstructions' in doc.draft) {
    doc.draft = {
      ...doc.draft,
      routeInstructions: docReadRoutes(doc, MAP_DEFAULT_NEWS_ID),
    }

    if ('mergedClaims' in doc.draft) {
      const source = docReadClaims(doc, 'numbered').length > 0
        ? docReadClaims(doc, 'numbered')
        : docReadClaims(doc, 'draft').filter(n => n.shouldSave)

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

  if (doc.transitionKey === '2-3' && doc.draft && 'scopeNodeId' in doc.draft) {
    doc.draft = {
      ...doc.draft,
      routeInstructions: docReadRoutes(doc, doc.draft.parentNodeId),
    }
  }

  if (doc.transitionKey === '0-1' && doc.draft && 'parsedContent' in doc.draft && 'newsNodeId' in doc.draft) {
    const parseDraft = doc.draft
    const newsNode = doc.nodes.find(
      (n): n is MapNewsNode => n.id === parseDraft.newsNodeId && n.kind === 'news',
    )
    if (newsNode) {
      doc.draft = { ...doc.draft, parsedContent: newsNode.params.content }
    }
  }
}

/** 某父节点下已占用的 subAgent instanceId（含 draft 路由）。 */
export function docReadInstanceIds(
  doc: MapGraphDoc,
  parentId: string,
): Array<Pick<MapSubAgentParams, 'instanceId'>> {
  const ids = doc.nodes
    .filter((n): n is MapSubAgentNode => n.kind === 'subAgent' && n.parentId === parentId)
    .map(n => ({ instanceId: n.params.instanceId }))
  const draft = doc.draft
  if (draft && 'routeInstructions' in draft && draft.routeInstructions) {
    for (const r of draft.routeInstructions) {
      const nodeId = mapIdCreateRoute(r, parentId)
      const node = doc.nodes.find(n => n.id === nodeId)
      if (node?.parentId === parentId) {
        if (!ids.some(i => i.instanceId === r.instanceId)) {
          ids.push({ instanceId: r.instanceId })
        }
      } else if (!node && parentId === MAP_DEFAULT_NEWS_ID) {
        if (!ids.some(i => i.instanceId === r.instanceId)) {
          ids.push({ instanceId: r.instanceId })
        }
      }
    }
  }
  return ids
}

/** 某父节点下 subAgent 槽位参数（与 routeInstructions 同形）。 */
export function docReadRoutes(doc: MapGraphDoc, parentId: string): MapSubAgentParams[] {
  return doc.nodes
    .filter((n): n is MapSubAgentNode => n.kind === 'subAgent' && n.parentId === parentId)
    .map(n => ({ ...n.params }))
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

function docReadClaims(doc: MapGraphDoc, phase: 'draft' | 'numbered'): MapClaimNode[] {
  if (phase === 'draft') {
    return doc.nodes
      .filter((n): n is MapClaimNode => n.kind === 'claim' && mapIdIsDraftClaim(n.id))
      .sort((a, b) => (mapIdReadDraftIndex(a.id) ?? 0) - (mapIdReadDraftIndex(b.id) ?? 0))
  }
  return doc.nodes
    .filter((n): n is MapClaimNode => n.kind === 'claim' && !mapIdIsDraftClaim(n.id))
    .sort((a, b) => Number(a.id) - Number(b.id))
}

function docUpdateSplitRoutes(
  doc: MapGraphDoc,
  routes: MapSubAgentParams[],
  parentId = MAP_DEFAULT_NEWS_ID,
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
  doc.transitionKey = undefined
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

function docPruneSplitUnder(doc: MapGraphDoc, newsParentId: string): void {
  const remove = new Set<string>()
  const collect = (parentId: string) => {
    for (const n of doc.nodes) {
      if (
        n.parentId === parentId
        && (n.kind === 'subAgent' || n.kind === 'claim' || n.kind === 'opinion')
        && !remove.has(n.id)
      ) {
        remove.add(n.id)
        collect(n.id)
      }
    }
  }
  collect(newsParentId)
  if (remove.size > 0) docDeleteNodes(doc, remove)
}

function docUpdateMap(
  doc: MapGraphDoc,
  content: string,
  newsId: string = MAP_DEFAULT_NEWS_ID,
): void {
  const existing = doc.nodes.find(
    (n): n is MapNewsNode => n.id === newsId && n.kind === 'news',
  )
  if (existing) {
    existing.params = { content }
    return
  }
  if (newsId === MAP_DEFAULT_NEWS_ID) {
    doc.nodes.push({
      id: MAP_DEFAULT_NEWS_ID,
      kind: 'news',
      params: { content },
    })
  }
}

export function docUpdateSubAgent(
  doc: MapGraphDoc,
  parentId: string,
  route: MapSubAgentParams,
): string {
  const id = mapIdCreateRoute(route, parentId)
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
  if (source.instanceId) {
    const route = splitRoutes.find(r => r.instanceId === source.instanceId)
    if (route) {
      const id = mapIdCreateRoute(route, MAP_DEFAULT_NEWS_ID)
      if (nodes.some(n => n.id === id)) return id
    }
    const byId = nodes.find(
      n => n.kind === 'subAgent' && n.params.instanceId === source.instanceId,
    )
    if (byId) return byId.id
  }
  if (source.agentName) {
    const byName = splitRoutes.filter(r => r.agentName === source.agentName)
    if (byName.length === 1) {
      const id = mapIdCreateRoute(byName[0], MAP_DEFAULT_NEWS_ID)
      if (nodes.some(n => n.id === id)) return id
    }
    const nodeByName = nodes.find(
      n => n.kind === 'subAgent' && n.params.agentName === source.agentName,
    )
    if (nodeByName) return nodeByName.id
  }
  return MAP_DEFAULT_NEWS_ID
}

function docUpdateDraftClaims(doc: MapGraphDoc, state: GraphSplitState): void {
  const routes = state.routeInstructions ?? []
  const rows = mapIdReadSubAgentClaim(state.subAgentResults ?? [])
  rows.forEach((row, index) => {
    const parentId = docReadClaimParent(
      doc.nodes,
      { instanceId: row.instanceId, agentName: row.agentName },
      routes,
    )
    docUpdateClaim(doc, {
      id: mapIdCreateDraftClaim(index),
      parentId,
      content: row.content,
      category: row.category,
      sourceAgent: row.sourceAgent,
      dataPhase: 'workerOut',
      shouldSave: true,
    })
  })
}

/** 按草稿下标只更新 shouldSave，不改 content / parent。 */
function docUpdateSaveFlags(doc: MapGraphDoc, state: GraphSplitState): void {
  const drafts = docReadClaims(doc, 'draft')
  mergeUpdateDraftFlags(drafts, state.mergedClaims ?? [])
}

function docUpdateNumberedClaims(
  doc: MapGraphDoc,
  state: GraphSplitState,
  routes: MapSubAgentParams[],
): void {
  if (!state.mergedClaims?.length) return
  state.mergedClaims.forEach((c, index) => {
    const id = mapIdCreateClaim(index)
    const persisted = index < state.saveIndex
    const parentId = docReadClaimParent(
      doc.nodes,
      { agentName: c.sourceAgent },
      routes,
    )
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
}

function docUpdateVerifyState(doc: MapGraphDoc, state: GraphVerifyState): void {
  const claimId = state.parentNodeId
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
      parentId: MAP_DEFAULT_NEWS_ID,
      content: state.claimContent,
      dataPhase: 'persisted',
      shouldSave: true,
    })
  }

  const routes = state.routeInstructions ?? []
  const routeNodeIds = new Set(routes.map(r => mapIdCreateRoute(r, claimId)))
  const staleIds = new Set(
    doc.nodes
      .filter(n => n.kind === 'subAgent' && n.parentId === claimId && !routeNodeIds.has(n.id))
      .map(n => n.id),
  )
  for (const n of doc.nodes) {
    if (n.parentId && staleIds.has(n.parentId)) staleIds.add(n.id)
  }
  docDeleteNodes(doc, staleIds)

  const workerOutOpinionIds = new Set(
    doc.nodes
      .filter(
        n => n.kind === 'opinion'
          && n.dataPhase === 'workerOut'
          && n.id.startsWith(`opinion:${claimId}:`),
      )
      .map(n => n.id),
  )
  docDeleteNodes(doc, workerOutOpinionIds)

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

function docIsDataKind(kind: MapNodeKind): boolean {
  return kind === 'source' || kind === 'news' || kind === 'claim' || kind === 'opinion'
}

function docIsAgentKind(kind: MapNodeKind): boolean {
  return kind === 'parseAgent' || kind === 'subAgent'
}

export function docCollectSubtree(snapshot: MapSnapshot, rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  for (const n of snapshot.nodes) {
    if (!n.parentId) continue
    const arr = childrenByParent.get(n.parentId) ?? []
    arr.push(n.id)
    childrenByParent.set(n.parentId, arr)
  }
  const ids = new Set<string>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    if (ids.has(id)) continue
    ids.add(id)
    for (const c of childrenByParent.get(id) ?? []) stack.push(c)
  }
  return ids
}

function docReadScopeRoot(snapshot: MapSnapshot, nodeId: string): string | undefined {
  const byId = new Map(snapshot.nodes.map(n => [n.id, n]))
  let id: string | undefined = nodeId
  while (id) {
    const node = byId.get(id)
    if (!node) return undefined
    if (!node.parentId) return id
    id = node.parentId
  }
  return undefined
}

function docReadRunScopeRoot(snapshot: MapSnapshot): string | undefined {
  const anchor = snapshot.activeNodeId ?? snapshot.timeline.activeScope
  if (!anchor) return undefined
  if (!snapshot.nodes.some(n => n.id === anchor)) return undefined
  return docReadScopeRoot(snapshot, anchor)
}

function docIsInRunScope(snapshot: MapSnapshot, nodeId: string): boolean {
  const root = docReadRunScopeRoot(snapshot)
  if (!root) return false
  return docCollectSubtree(snapshot, root).has(nodeId)
}

function docIsRunScopeLock(snapshot: MapSnapshot, nodeId: string): boolean {
  return snapshot.runPhase === 'running' && docIsInRunScope(snapshot, nodeId)
}

function docHasSuccessorAgent(snapshot: MapSnapshot, nodeId: string): boolean {
  const subtree = docCollectSubtree(snapshot, nodeId)
  subtree.delete(nodeId)
  return snapshot.nodes.some(
    n => subtree.has(n.id) && docIsAgentKind(n.kind),
  )
}

function docHasSuccessorData(snapshot: MapSnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node) return false
  const baseCol = layoutReadNodeColumn(node, snapshot.nodes)
  const subtree = docCollectSubtree(snapshot, nodeId)
  subtree.delete(nodeId)
  return snapshot.nodes.some(n => {
    if (!subtree.has(n.id) || !docIsDataKind(n.kind)) return false
    return layoutReadNodeColumn(n, snapshot.nodes) > baseCol
  })
}

function docIsRouteParent(node: MapNode): boolean {
  if (node.kind === 'news') return true
  if (node.kind === 'claim' && node.dataPhase === 'persisted') return true
  return false
}

function docCanEditDataContent(snapshot: MapSnapshot, nodeId: string): boolean {
  if (docIsRunScopeLock(snapshot, nodeId)) return false
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node) return false
  if (node.kind === 'opinion' || node.kind === 'parseAgent') return false
  if (node.kind === 'claim') {
    if (node.dataPhase !== 'workerOut') return false
    return !docHasSuccessorAgent(snapshot, nodeId)
  }
  if (node.kind === 'news' || node.kind === 'source') {
    return !docHasSuccessorAgent(snapshot, nodeId)
  }
  return false
}

function docCanEditDataRoute(snapshot: MapSnapshot, nodeId: string): boolean {
  if (docIsRunScopeLock(snapshot, nodeId)) return false
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node || !docIsRouteParent(node)) return false
  return !docHasSuccessorData(snapshot, nodeId)
}

function docCanEditSubAgentParams(snapshot: MapSnapshot, nodeId: string): boolean {
  if (docIsRunScopeLock(snapshot, nodeId)) return false
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node || node.kind !== 'subAgent') return false
  return !docHasSuccessorData(snapshot, nodeId)
}

/** 正文/params 维是否锁定（Topology 半锁样式、Inspector textarea）。 */
export function docIsParamLock(snapshot: MapSnapshot, node: MapNode): boolean {
  if (node.kind === 'opinion' || node.kind === 'parseAgent') return true
  if (node.kind === 'claim' && node.dataPhase !== 'workerOut') return true
  if (node.kind === 'subAgent') {
    return !docCanEditSubAgentParams(snapshot, node.id)
  }
  return !docCanEditDataContent(snapshot, node.id)
}

/** 能否编辑节点 params（正文 / SubAgent priority·hint）。 */
export function docCanEditNode(snapshot: MapSnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node) return false
  if (node.kind === 'subAgent') return docCanEditSubAgentParams(snapshot, nodeId)
  return docCanEditDataContent(snapshot, nodeId)
}

/** 能否在 parent 下新增 SubAgent（route 维）。 */
export function docCanAddSubAgent(snapshot: MapSnapshot, parentNodeId: string): boolean {
  return docCanEditDataRoute(snapshot, parentNodeId)
}

/** 能否手动移除空 SubAgent 槽（route 维，与 add 对称）。 */
export function docCanRemoveNode(snapshot: MapSnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node || node.kind !== 'subAgent') return false
  if (docHasSuccessorData(snapshot, nodeId)) return false
  if (!node.parentId) return false
  return docCanEditDataRoute(snapshot, node.parentId)
}

/** Inspector 锁定原因一行文案。 */
export function docReadLockReason(snapshot: MapSnapshot, nodeId: string): string | undefined {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node) return undefined
  if (node.kind === 'opinion') return '意见节点只读'
  if (node.kind === 'parseAgent') return '解析节点不可编辑'
  if (docIsRunScopeLock(snapshot, nodeId)) return '当前子树正在运行'
  if (node.kind === 'subAgent' && docHasSuccessorData(snapshot, nodeId)) {
    return '已产出下游数据'
  }
  if (node.kind === 'claim' && node.dataPhase === 'persisted') return '事实已持久化'
  if (docHasSuccessorAgent(snapshot, nodeId)) return '已配置工艺节点'
  if ((node.kind === 'news' || node.kind === 'claim') && docHasSuccessorData(snapshot, nodeId)) {
    return '已产出下游数据'
  }
  return undefined
}
