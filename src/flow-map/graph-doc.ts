/**
 * Map 层内存图：按 mapId 维护一张可变图，整合 LangGraph 事件与人的 CRUD。
 * 含快照上的能力判定（锁 / canAdd / canEdit / canRemove）。
 */
import {
  MAP_DEFAULT_NEWS_ID,
  mapIdCreateClaim,
  mapIdCreateParse,
  mapIdCreateRoute,
  mapIdCreateChain,
  mapIdCreateSource,
  mapIdCreateNews,
  mapIdReadChain,
  mapIdIsDraftClaim,
  mapIdReadSubAgent,
} from './ids'
import type {
  ExecutionMode,
  MapAgentStream,
  MapClaimNode,
  MapEdge,
  MapNode,
  MapNodeKind,
  MapNewsNode,
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
  docDeleteNodes,
  docReadClaims,
  docUpdateClaim,
  docUpdateEdge,
  docUpdateMap,
  docUpdateSubAgent,
} from './graph-mutators'
import {
  projReadGatePolicy,
  projReadSpec,
  projDeleteSubtree,
  projResetDefaultNews,
  projUpdateRouteSlots,
  projReadSplitClaimParent,
  projUpdateVerifyOpinion,
} from './projection/registry'
import {
  type DisplayMap,
  type DisplayClaim,
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
  /** route / merge 流式缓冲（不落库）。 */
  agentStream?: MapAgentStream
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
    agentStream: doc.agentStream
      ? { ...doc.agentStream }
      : undefined,
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
  projUpdateRouteSlots(doc, MAP_DEFAULT_NEWS_ID, splitRoutes, {})

  for (const c of news.claims) {
    const claimParent = projReadSplitClaimParent(
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
    projUpdateVerifyOpinion(doc, c.claimId, [], opinions, opinions.length)
  }

  doc.runPhase = 'idle'
  doc.error = undefined
  docDeleteFocus(doc)
  return doc
}

/** 从 chains 核查结果补齐 mapGraph 中缺失的 opinion / verify 槽。 */
export function docReconcileVerify(doc: MapGraphDoc, claims: DisplayClaim[]): void {
  for (const c of claims) {
    const opinions = c.verifyResult?.opinions ?? []
    if (opinions.length === 0) continue
    if (!doc.nodes.some(n => n.id === c.claimId && n.kind === 'claim')) continue
    projUpdateVerifyOpinion(doc, c.claimId, [], opinions, opinions.length)
  }
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
  if (payload.event === 'subagent_delta') {
    docUpdateDeltaProgress(doc, payload)
    return
  }
  if (payload.event === 'agent_delta') {
    docUpdateAgentProgress(doc, payload)
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

type GraphRunProgressPayload = Exclude<
  GraphProgressPayload,
  { event: 'subagent_tool' } | { event: 'subagent_delta' } | { event: 'agent_delta' }
>
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

function docUpdateDeltaProgress(
  doc: MapGraphDoc,
  payload: Extract<GraphProgressPayload, { event: 'subagent_delta' }>,
): void {
  if (doc.runPhase !== 'running') {
    doc.runPhase = 'running'
    doc.pendingTool = undefined
  }

  const node = doc.nodes.find(n => n.id === payload.nodeId)
  if (!node || !payload.text) return

  const stream = {
    thinking: node.runtime?.stream?.thinking ?? '',
    text: node.runtime?.stream?.text ?? '',
  }
  if (payload.channel === 'thinking') stream.thinking += payload.text
  else stream.text += payload.text

  node.runtime = { ...node.runtime, stream }
}

function docUpdateAgentProgress(
  doc: MapGraphDoc,
  payload: Extract<GraphProgressPayload, { event: 'agent_delta' }>,
): void {
  if (doc.runPhase !== 'running') {
    doc.runPhase = 'running'
    doc.pendingTool = undefined
  }
  if (!payload.text) return

  const prev = doc.agentStream
  const base: MapAgentStream = prev?.node === payload.node
    ? prev
    : { node: payload.node, thinking: '', text: '' }

  doc.agentStream = payload.channel === 'thinking'
    ? { ...base, thinking: base.thinking + payload.text }
    : { ...base, text: base.text + payload.text }
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

  if (
    payload.event === 'node_enter'
    && (payload.node === 'route' || payload.node === 'merge')
  ) {
    doc.agentStream = { node: payload.node, thinking: '', text: '' }
  }

  if (payload.event === 'fanout_spawn' && payload.nodeId) {
    if (doc.transitionKey === '0-1') {
      docUpdateFanoutParseAgent(doc, payload as GraphFanoutSpawnPayload)
    } else {
      docUpdateFanoutSubAgent(doc, payload as GraphFanoutSpawnPayload)
    }
  }

  if (payload.event === 'node_exit' && payload.node === 'subAgent') {
    docDeleteSubAgentSkill(doc)
    docDeleteStream(doc)
  }

  if (
    payload.event === 'node_exit'
    && (payload.node === 'route' || payload.node === 'merge')
  ) {
    docDeleteAgentStream(doc)
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

  const spec = projReadSpec(payload.transitionKey)
  const policy = projReadGatePolicy(payload.nextNode)
  if (policy.pruneWorkerSubtree) {
    const anchorId = spec.readAnchorId(payload.state)
    projDeleteSubtree(doc, anchorId, spec.pruneKinds)
    if (spec.resetDefaultNews && anchorId === MAP_DEFAULT_NEWS_ID) {
      projResetDefaultNews(doc)
    }
  }
  spec.updateGraph(doc, payload.state, { upcomingGate: payload.nextNode })

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
    upcomingGate?: GraphInterruptNode
    completedNode?: string
  },
): void {
  projReadSpec(transitionKey).updateGraph(doc, state, ctx)
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

export interface DocDedupClaimsResult {
  removedIds: string[]
  kept: number
}

export interface DocBatchSubAgentPatch {
  priority?: Priority
  hint?: string
  agentName?: string
  parentNodeId?: string
}

/** 同 parent 下按 content+category 去重 claim。 */
export function docDedupClaims(doc: MapGraphDoc): DocDedupClaimsResult {
  const removedIds: string[] = []
  const byParent = new Map<string, MapClaimNode[]>()

  for (const node of doc.nodes) {
    if (node.kind !== 'claim') continue
    const parent = node.parentId
    if (!parent) continue
    const list = byParent.get(parent) ?? []
    list.push(node)
    byParent.set(parent, list)
  }

  const toRemove = new Set<string>()
  for (const claims of byParent.values()) {
    const seen = new Map<string, string>()
    for (const claim of claims) {
      const key = `${claim.params.content.trim().toLowerCase()}|${(claim.params.category ?? '').trim().toLowerCase()}`
      if (seen.has(key)) {
        toRemove.add(claim.id)
        removedIds.push(claim.id)
      } else {
        seen.set(key, claim.id)
      }
    }
  }

  if (toRemove.size > 0) docDeleteNodes(doc, toRemove)
  return {
    removedIds,
    kept: doc.nodes.filter(n => n.kind === 'claim').length,
  }
}

export function docBatchUpdateSubAgents(
  doc: MapGraphDoc,
  patch: DocBatchSubAgentPatch,
): number {
  let count = 0
  for (const node of doc.nodes) {
    if (node.kind !== 'subAgent') continue
    if (patch.parentNodeId && node.parentId !== patch.parentNodeId) continue
    if (patch.agentName && node.params.agentName !== patch.agentName) continue
    let touched = false
    if (patch.priority !== undefined) {
      node.params.priority = patch.priority
      touched = true
    }
    if (patch.hint !== undefined) {
      node.params.hint = patch.hint
      touched = true
    }
    if (touched) count++
  }
  return count
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
  if (!doc.draft) return null
  const key = doc.transitionKey ?? docReadDraftTransitionKey(doc.draft)
  if (!key) return null
  return projReadSpec(key).readResume?.(doc) ?? null
}

function docReadDraftTransitionKey(
  draft: NonNullable<MapGraphDoc['draft']>,
): TransitionKey | undefined {
  if ('parsedContent' in draft && 'newsNodeId' in draft) return '0-1'
  if ('scopeNodeId' in draft) return '2-3'
  if ('content' in draft && 'parentNodeId' in draft) return '1-2'
  return undefined
}

/** 从图上 subAgent / claim 写回 draft，供 resume。 */
export function docUpdateDraft(doc: MapGraphDoc): void {
  if (!doc.draft) return
  const key = doc.transitionKey ?? docReadDraftTransitionKey(doc.draft)
  if (!key) return
  projReadSpec(key).updateDraft?.(doc)
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

export function docDeleteFocus(doc: MapGraphDoc): void {
  doc.activeNodeId = undefined
  doc.pendingTool = undefined
  doc.nextNode = undefined
  docDeleteRuntime(doc)
}

/** 清除运行会话（mapRun / interrupt 焦点），图节点保留。 */
export function docClearRunSession(doc: MapGraphDoc): void {
  doc.runPhase = 'idle'
  doc.activeNodeId = undefined
  doc.pendingTool = undefined
  doc.nextNode = undefined
  doc.runId = undefined
  doc.threadId = undefined
  doc.transitionKey = undefined
  doc.draft = undefined
  doc.error = undefined
  docDeleteAgentStream(doc)
  docDeleteStream(doc)
}

// —— internals ——

export { docDeleteNodes, docReadClaims, docReadRoutes, docUpdateSubAgent } from './graph-mutators'

function docDeleteRunSession(doc: MapGraphDoc): void {
  docClearRunSession(doc)
}

function docDeleteSkill(node: MapNode): void {
  if (!node.runtime?.activeSkill) return
  const { activeSkill: _drop, ...rest } = node.runtime
  node.runtime = Object.keys(rest).length > 0 ? rest : undefined
}

function docDeleteNodeStream(node: MapNode): void {
  if (!node.runtime?.stream) return
  const { stream: _drop, ...rest } = node.runtime
  node.runtime = Object.keys(rest).length > 0 ? rest : undefined
}

function docDeleteStream(doc: MapGraphDoc): void {
  for (const n of doc.nodes) {
    if (n.kind !== 'subAgent') continue
    docDeleteNodeStream(n)
  }
}

function docDeleteAgentStream(doc: MapGraphDoc): void {
  doc.agentStream = undefined
}

function docDeleteRuntime(doc: MapGraphDoc): void {
  for (const n of doc.nodes) {
    if (n.runtime) delete n.runtime
  }
  docDeleteAgentStream(doc)
}

/** 清除 HITL runtime 标记，保留 activeSkill / stream（并行 SubAgent）。 */
function docDeleteHitlRuntime(doc: MapGraphDoc): void {
  for (const n of doc.nodes) {
    if (!n.runtime) continue
    const { activeSkill, stream } = n.runtime
    if (activeSkill || stream) {
      n.runtime = {
        ...(activeSkill ? { activeSkill } : {}),
        ...(stream ? { stream } : {}),
      }
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
