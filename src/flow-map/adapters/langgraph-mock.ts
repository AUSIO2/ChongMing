/**
 * LangGraph 形态的 Mock Adapter。
 *
 * Adapter 内部允许自由使用 LangGraph 概念（split / verify / route / pending），
 * 但对外只吐 `MapSnapshot`。禁止把内部形态类型泄漏到 Port。
 */
import type { AddSubAgentInput, MapAPI, UpdateNodeParamsInput } from '../api'
import {
  NEWS_ROOT_ID,
  edgeId,
  opinionNodeId,
  subAgentId,
  workerClaimNodeId,
} from '../ids'
import type {
  ClaimMapNode,
  ClaimParams,
  DataPhase,
  ExecutionMode,
  MapEdge,
  MapNode,
  MapSnapshot,
  NewsMapNode,
  NewsParams,
  OpinionMapNode,
  OpinionParams,
  RunPhase,
  SubAgentEntry,
  SubAgentMapNode,
  SubAgentParams,
  ToolKind,
} from '../types'
import {
  buildSplitSubAgentCatalog,
  buildVerifySubAgentCatalog,
  catalogDefaultPriority,
  demoClaimForSubAgent,
  demoOpinionForClaim,
} from '../fixtures/demo'
import {
  canAddSubAgent as canAddSubAgentPure,
  canEditNode as canEditNodePure,
  canRemoveNode as canRemoveNodePure,
} from '../graph-ops'

// ---------- 内部形态（Adapter-only，不出圈） ----------

type InstanceId = string

interface InternalClaim {
  instanceId: InstanceId
  index: number
  params: ClaimParams
  dataPhase: DataPhase
}

interface InternalOpinion {
  instanceId: InstanceId
  index: number
  targetClaimNodeId: string
  params: OpinionParams
  dataPhase: DataPhase
}

interface InternalSubAgent {
  instanceId: InstanceId
  params: SubAgentParams
  /** 挂靠点：news root（拆分）或已持久化 claim 的节点 id（核查）。 */
  attachTo: string
  /** 该 subAgent 所属的编排 slice —— 仅 adapter 内部使用。 */
  slice: 'split' | 'verify'
  /** 若为 verify，绑定的 claim 节点 id。 */
  verifyClaimNodeId?: string
}

interface InternalState {
  newsId: string
  news: NewsParams
  mode: ExecutionMode
  runPhase: RunPhase
  subAgents: InternalSubAgent[]
  claims: Record<InstanceId, InternalClaim[]>
  opinions: Record<InstanceId, InternalOpinion[]>
  /** 当前焦点节点 id + 等待执行的工具（一次 interrupt 仅一对）。 */
  activeNodeId?: string
  pendingTool?: ToolKind
  error?: string
}

// ---------- Adapter 实现 ----------

export interface LangGraphMockAdapterOptions {
  seedNews?: Array<{
    newsId: string
    title?: string
    content?: string
    mode?: ExecutionMode
  }>
  /** 为未知 newsId 自动创建空的 idle 状态（web 预览时匹配任意 mock 新闻 id）。 */
  autoSeedUnknown?: boolean
  /** 未知 newsId 首次访问时的内容解析器（惰性拉新闻正文）。 */
  resolveNews?: (newsId: string) => Promise<{ title?: string; content: string } | null>
}

export function createLangGraphMockAdapter(
  options: LangGraphMockAdapterOptions = {},
): MapAPI {
  const store = new Map<string, InternalState>()
  const listeners = new Set<(newsId: string) => void>()
  const autoSeed = options.autoSeedUnknown ?? true

  for (const seed of options.seedNews ?? []) {
    store.set(
      seed.newsId,
      freshState(seed.newsId, seed.mode ?? 'human-in-loop', {
        title: seed.title,
        content: seed.content ?? '',
      }),
    )
  }

  function emit(newsId: string) {
    for (const l of listeners) l(newsId)
  }

  function requireState(newsId: string): InternalState {
    let s = store.get(newsId)
    if (!s) {
      if (!autoSeed) throw new Error(`news not found: ${newsId}`)
      s = freshState(newsId, 'human-in-loop', { content: '' })
      store.set(newsId, s)
    }
    return s
  }

  async function ensureNewsContent(state: InternalState): Promise<void> {
    if (state.news.content) return
    if (!options.resolveNews) return
    const resolved = await options.resolveNews(state.newsId)
    if (resolved) state.news = { title: resolved.title, content: resolved.content }
  }

  function toSnapshot(state: InternalState): MapSnapshot {
    const nodes: MapNode[] = []
    const edges: MapEdge[] = []

    // 1) 新闻节点作为拓扑真根
    const newsNode: NewsMapNode = {
      id: NEWS_ROOT_ID,
      kind: 'news',
      params: { ...state.news },
    }
    nodes.push(newsNode)

    // 2) SubAgent（含拆分槽 → 新闻节点，核查槽 → claim 节点）
    for (const sa of state.subAgents) {
      const id = subAgentId(sa.instanceId)
      const parentId = sa.attachTo
      const node: SubAgentMapNode = {
        id,
        kind: 'subAgent',
        parentId,
        params: { ...sa.params },
      }
      attachFocusRuntime(node, state)
      nodes.push(node)

      edges.push({ id: edgeId(parentId, id), from: parentId, to: id })
    }

    for (const sa of state.subAgents) {
      const parentNodeId = subAgentId(sa.instanceId)
      const cs = state.claims[sa.instanceId] ?? []
      for (const c of cs) {
        const id = workerClaimNodeId(sa.instanceId, c.index)
        const node: ClaimMapNode = {
          id,
          kind: 'claim',
          parentId: parentNodeId,
          params: { ...c.params },
          dataPhase: c.dataPhase,
        }
        attachFocusRuntime(node, state)
        nodes.push(node)
        edges.push({ id: edgeId(parentNodeId, id), from: parentNodeId, to: id })
      }

      const os = state.opinions[sa.instanceId] ?? []
      for (const o of os) {
        const id = opinionNodeId(o.targetClaimNodeId, o.index)
        const node: OpinionMapNode = {
          id,
          kind: 'opinion',
          parentId: parentNodeId,
          params: { ...o.params },
          dataPhase: o.dataPhase,
        }
        attachFocusRuntime(node, state)
        nodes.push(node)
        edges.push({ id: edgeId(parentNodeId, id), from: parentNodeId, to: id })
      }
    }

    // news 也可能成为焦点（例如未来的全局工具）
    attachFocusRuntime(newsNode, state)

    return {
      newsId: state.newsId,
      nodes,
      edges,
      runPhase: state.runPhase,
      mode: state.mode,
      activeNodeId: state.activeNodeId,
      pendingTool: state.pendingTool,
      error: state.error,
    }
  }

  // -------- API --------

  const api: MapAPI = {
    async getSnapshot(newsId) {
      const state = requireState(newsId)
      await ensureNewsContent(state)
      return toSnapshot(state)
    },

    async getSubAgentCatalog(parentNodeId) {
      if (parentNodeId === NEWS_ROOT_ID) return buildSplitSubAgentCatalog()
      return buildVerifySubAgentCatalog()
    },

    async addSubAgent(input: AddSubAgentInput) {
      const state = requireState(input.newsId)
      const snapshot = toSnapshot(state)
      if (!canAddSubAgentPure(snapshot, input.parentNodeId)) {
        throw new Error(`cannot add SubAgent under ${input.parentNodeId}`)
      }
      const instanceId = randomInstanceId(input.params.agentName)
      if (input.parentNodeId === NEWS_ROOT_ID) {
        state.subAgents.push({
          instanceId,
          params: input.params,
          attachTo: NEWS_ROOT_ID,
          slice: 'split',
        })
      } else {
        state.subAgents.push({
          instanceId,
          params: input.params,
          attachTo: input.parentNodeId,
          slice: 'verify',
          verifyClaimNodeId: input.parentNodeId,
        })
      }
      emit(input.newsId)
      return toSnapshot(state)
    },

    async updateNodeParams(input: UpdateNodeParamsInput) {
      const state = requireState(input.newsId)
      const snapshot = toSnapshot(state)
      if (!canEditNodePure(snapshot, input.nodeId)) {
        throw new Error(`cannot edit ${input.nodeId}`)
      }
      applyParamsPatch(state, input.nodeId, input.params)
      emit(input.newsId)
      return toSnapshot(state)
    },

    async removeNode(input) {
      const state = requireState(input.newsId)
      const snapshot = toSnapshot(state)
      if (!canRemoveNodePure(snapshot, input.nodeId)) {
        throw new Error(`cannot remove ${input.nodeId}`)
      }
      const target = state.subAgents.find(s => subAgentId(s.instanceId) === input.nodeId)
      if (target) {
        state.subAgents = state.subAgents.filter(s => s !== target)
        delete state.claims[target.instanceId]
        delete state.opinions[target.instanceId]
      }
      emit(input.newsId)
      return toSnapshot(state)
    },

    async startRun(newsId, mode) {
      const state = requireState(newsId)
      if (mode) state.mode = mode
      if (state.runPhase === 'running' || state.runPhase === 'interrupted') {
        return { runId: newsId, snapshot: toSnapshot(state) }
      }
      state.error = undefined
      // 重新跑：清掉上次产出，保留人工已加的拆分槽
      state.claims = {}
      state.opinions = {}
      state.subAgents = state.subAgents.filter(s => s.slice === 'split')
      // Route Agent 预置（catalog），与人工槽合并；然后 interrupt 让人继续加槽
      ensureSplitRoutesFromCatalog(state)
      beginInvokeInterrupt(state, NEWS_ROOT_ID)
      emit(newsId)
      return { runId: newsId, snapshot: toSnapshot(state) }
    },

    async continueStep(newsId) {
      const state = requireState(newsId)
      if (state.runPhase !== 'interrupted') return toSnapshot(state)

      if (state.pendingTool === 'invoke') {
        commitInvoke(state)
        emit(newsId)
        return toSnapshot(state)
      }

      commitActive(state)
      advanceAfterCommit(state)
      emit(newsId)
      return toSnapshot(state)
    },

    async cancel(newsId) {
      const state = requireState(newsId)
      state.runPhase = 'idle'
      state.activeNodeId = undefined
      state.pendingTool = undefined
      state.error = undefined
      emit(newsId)
      return toSnapshot(state)
    },

    async setMode(newsId, mode) {
      const state = requireState(newsId)
      state.mode = mode
      emit(newsId)
      return toSnapshot(state)
    },

    onUpdated(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }

  return api
}

// ---------- 内部辅助 ----------

function freshState(newsId: string, mode: ExecutionMode, news: NewsParams): InternalState {
  return {
    newsId,
    news,
    mode,
    runPhase: 'idle',
    subAgents: [],
    claims: {},
    opinions: {},
  }
}

/** 焦点节点带上 runtime 标记（claim/opinion/subAgent/news 一视同仁）。 */
function attachFocusRuntime(
  node: MapNode,
  state: InternalState,
): void {
  if (state.activeNodeId !== node.id || !state.pendingTool) return
  if (state.runPhase === 'interrupted') {
    node.runtime = { pendingTool: state.pendingTool }
  } else if (state.runPhase === 'running') {
    node.runtime = { activeTool: state.pendingTool }
  }
}

function applyParamsPatch(state: InternalState, nodeId: string, patch: unknown): void {
  if (nodeId === NEWS_ROOT_ID) {
    Object.assign(state.news, patch as Partial<NewsParams>)
    return
  }
  const sa = state.subAgents.find(s => subAgentId(s.instanceId) === nodeId)
  if (sa) {
    Object.assign(sa.params, patch as Partial<SubAgentParams>)
    return
  }
  for (const [instanceId, cs] of Object.entries(state.claims)) {
    const c = cs.find(x => workerClaimNodeId(instanceId, x.index) === nodeId)
    if (c) {
      Object.assign(c.params, patch as Partial<ClaimParams>)
      return
    }
  }
  for (const os of Object.values(state.opinions)) {
    const o = os.find(x => opinionNodeId(x.targetClaimNodeId, x.index) === nodeId)
    if (o) {
      Object.assign(o.params, patch as Partial<OpinionParams>)
      return
    }
  }
  throw new Error(`node not found: ${nodeId}`)
}

/**
 * 模拟 MainAgent route：用拆分 catalog 预置槽，保留人工已加的额外槽（按 agentName 去重合并）。
 */
function ensureSplitRoutesFromCatalog(state: InternalState): void {
  const catalog = buildSplitSubAgentCatalog()
  catalog.forEach((entry, index) => {
    const exists = state.subAgents.some(
      s => s.slice === 'split' && s.params.agentName === entry.agentName,
    )
    if (exists) return
    state.subAgents.push({
      instanceId: randomInstanceId(entry.agentName),
      params: {
        agentName: entry.agentName,
        displayLabel: entry.displayLabel,
        description: entry.description,
        priority: catalogDefaultPriority(entry, index),
        hint: `Route：重点从「${entry.displayLabel}」视角拆分`,
      },
      attachTo: NEWS_ROOT_ID,
      slice: 'split',
    })
  })
}

function beginInvokeInterrupt(state: InternalState, nodeId: string): void {
  state.runPhase = 'interrupted'
  state.activeNodeId = nodeId
  state.pendingTool = 'invoke'
}

/** 确认 invoke：跑当前作用域下尚未产出的 SubAgent，再进入按条 save。 */
function commitInvoke(state: InternalState): void {
  const focusId = state.activeNodeId
  state.activeNodeId = undefined
  state.pendingTool = undefined

  if (!focusId || focusId === NEWS_ROOT_ID) {
    simulateInvokeAllOfSlice(state, 'split')
    enterFirstSaveInterrupt(state, 'split')
    return
  }

  // 焦点在 claim 上：对该 claim 下的核查 SubAgent 做 invoke
  const claimNodeId = focusId
  for (const sa of state.subAgents) {
    if (sa.slice !== 'verify' || sa.verifyClaimNodeId !== claimNodeId) continue
    simulateVerifyInvokeFor(state, sa)
  }
  enterFirstOpinionSaveForClaim(state, claimNodeId)
}

function enterFirstOpinionSaveForClaim(state: InternalState, claimNodeId: string): void {
  for (const sa of state.subAgents) {
    if (sa.slice !== 'verify' || sa.verifyClaimNodeId !== claimNodeId) continue
    const os = state.opinions[sa.instanceId] ?? []
    const first = os.find(o => o.dataPhase === 'workerOut')
    if (first) {
      beginSaveInterrupt(state, opinionNodeId(first.targetClaimNodeId, first.index))
      return
    }
  }
  // 该 claim 无 opinion → 尝试下一 claim 的核查配置
  advanceToNextVerifyConfigure(state)
}

function advanceToNextVerifyConfigure(state: InternalState): void {
  const nextClaimId = nextPersistedClaimNeedingVerify(state)
  if (nextClaimId) {
    // 该 claim 的 Verify Route Agent 预置槽，再 interrupt 让人加槽
    runVerifyRouteForClaim(state, nextClaimId)
    beginInvokeInterrupt(state, nextClaimId)
    return
  }
  state.runPhase = 'completed'
  state.activeNodeId = undefined
  state.pendingTool = undefined
}

function nextPersistedClaimNeedingVerify(state: InternalState): string | undefined {
  for (const sa of state.subAgents) {
    if (sa.slice !== 'split') continue
    for (const c of state.claims[sa.instanceId] ?? []) {
      if (c.dataPhase !== 'persisted') continue
      const claimNodeId = workerClaimNodeId(sa.instanceId, c.index)
      const verifyAgents = state.subAgents.filter(
        v => v.slice === 'verify' && v.verifyClaimNodeId === claimNodeId,
      )
      const anyOpinion = verifyAgents.some(
        v => (state.opinions[v.instanceId] ?? []).length > 0,
      )
      if (!anyOpinion) return claimNodeId
    }
  }
  return undefined
}

/**
 * 模拟该 claim 上的 Verify Route Agent：catalog 预置核查槽，保留人工已加的额外槽。
 * 与 news 上的 Split Route Agent 对称。
 */
function runVerifyRouteForClaim(state: InternalState, claimNodeId: string): void {
  const catalog = buildVerifySubAgentCatalog()
  catalog.forEach((entry, index) => {
    const exists = state.subAgents.some(
      s =>
        s.slice === 'verify'
        && s.verifyClaimNodeId === claimNodeId
        && s.params.agentName === entry.agentName,
    )
    if (exists) return
    state.subAgents.push({
      instanceId: randomInstanceId(entry.agentName),
      params: {
        agentName: entry.agentName,
        displayLabel: entry.displayLabel,
        description: entry.description,
        priority: catalogDefaultPriority(entry, index),
        hint: `Route：从「${entry.displayLabel}」角度核查该事实`,
      },
      attachTo: claimNodeId,
      slice: 'verify',
      verifyClaimNodeId: claimNodeId,
    })
  })
}

function simulateInvokeAllOfSlice(state: InternalState, slice: 'split' | 'verify'): void {
  for (const sa of state.subAgents) {
    if (sa.slice !== slice) continue
    // 该 SubAgent 尚未产出任何 claim/opinion 时补产
    if (slice === 'split') {
      const already = state.claims[sa.instanceId]
      if (already && already.length) continue
      const count = 2 + (sa.instanceId.length % 2) // 2 or 3
      const list: InternalClaim[] = []
      for (let i = 0; i < count; i++) {
        list.push({
          instanceId: sa.instanceId,
          index: i,
          params: demoClaimForSubAgent(sa.params.agentName, i),
          dataPhase: 'workerOut',
        })
      }
      state.claims[sa.instanceId] = list
    } else {
      const already = state.opinions[sa.instanceId]
      if (already && already.length) continue
      simulateVerifyInvokeFor(state, sa)
    }
  }
}

function enterFirstSaveInterrupt(state: InternalState, slice: 'split' | 'verify'): void {
  // 找该 slice 下第一个仍处于 workerOut 的数据节点作为焦点
  for (const sa of state.subAgents) {
    if (sa.slice !== slice) continue
    if (slice === 'split') {
      const cs = state.claims[sa.instanceId] ?? []
      const first = cs.find(c => c.dataPhase === 'workerOut')
      if (first) {
        beginSaveInterrupt(state, workerClaimNodeId(sa.instanceId, first.index))
        return
      }
    } else {
      const os = state.opinions[sa.instanceId] ?? []
      const first = os.find(o => o.dataPhase === 'workerOut')
      if (first) {
        beginSaveInterrupt(state, opinionNodeId(first.targetClaimNodeId, first.index))
        return
      }
    }
  }
  // 找不到 → 全部完成
  state.runPhase = 'completed'
  state.activeNodeId = undefined
  state.pendingTool = undefined
}

function beginSaveInterrupt(state: InternalState, nodeId: string): void {
  state.runPhase = 'interrupted'
  state.activeNodeId = nodeId
  state.pendingTool = 'save'
}

/** 提交当前焦点节点的 pending 工具（save）。 */
function commitActive(state: InternalState): void {
  if (!state.activeNodeId || !state.pendingTool) return
  const nodeId = state.activeNodeId
  transitionDataPhase(state, nodeId, 'persisted')
  // claim 落盘后立刻跑该 claim 的 Verify Route Agent（预置核查槽，idle）
  if (state.pendingTool === 'save' && findClaimByNodeId(state, nodeId)) {
    runVerifyRouteForClaim(state, nodeId)
  }
}

function transitionDataPhase(
  state: InternalState,
  nodeId: string,
  to: DataPhase,
): void {
  for (const [instanceId, cs] of Object.entries(state.claims)) {
    const c = cs.find(x => workerClaimNodeId(instanceId, x.index) === nodeId)
    if (c) {
      c.dataPhase = to
      return
    }
  }
  for (const os of Object.values(state.opinions)) {
    const o = os.find(x => opinionNodeId(x.targetClaimNodeId, x.index) === nodeId)
    if (o) {
      o.dataPhase = to
      return
    }
  }
}

/**
 * save 提交后的下一步：
 * 1) 还有 workerOut claim → 下一条 claim save
 * 2) 还有 workerOut opinion → 下一条 opinion save
 * 3) 拆分全 persist → 下一 claim 的 Verify Route 已在落盘时跑过，进入 invoke 中断（人工可再加核查槽）
 * 4) 否则 completed
 */
function advanceAfterCommit(state: InternalState): void {
  for (const sa of state.subAgents) {
    if (sa.slice !== 'split') continue
    const cs = state.claims[sa.instanceId] ?? []
    const next = cs.find(c => c.dataPhase === 'workerOut')
    if (next) {
      beginSaveInterrupt(state, workerClaimNodeId(sa.instanceId, next.index))
      return
    }
  }

  for (const sa of state.subAgents) {
    if (sa.slice !== 'verify') continue
    const os = state.opinions[sa.instanceId] ?? []
    const next = os.find(o => o.dataPhase === 'workerOut')
    if (next) {
      beginSaveInterrupt(state, opinionNodeId(next.targetClaimNodeId, next.index))
      return
    }
  }

  // 拆分完成 → 下一 claim：Verify Route Agent 预置后 invoke 中断（人工可再加槽）
  const nextClaimId = nextPersistedClaimNeedingVerify(state)
  if (nextClaimId) {
    runVerifyRouteForClaim(state, nextClaimId)
    beginInvokeInterrupt(state, nextClaimId)
    return
  }

  state.runPhase = 'completed'
  state.activeNodeId = undefined
  state.pendingTool = undefined
}

/** 同一 claim 下 opinion 的全局下标（与后端 subAgentOpinions[i] / opinionNodeId 对齐）。 */
function nextOpinionIndexForClaim(state: InternalState, claimNodeId: string): number {
  let max = -1
  for (const os of Object.values(state.opinions)) {
    for (const o of os) {
      if (o.targetClaimNodeId === claimNodeId) max = Math.max(max, o.index)
    }
  }
  return max + 1
}

function simulateVerifyInvokeFor(state: InternalState, sa: InternalSubAgent): void {
  if (!sa.verifyClaimNodeId) return
  const claim = findClaimByNodeId(state, sa.verifyClaimNodeId)
  if (!claim) return
  const list: InternalOpinion[] = state.opinions[sa.instanceId] ?? []
  if (list.length > 0) return
  const index = nextOpinionIndexForClaim(state, sa.verifyClaimNodeId)
  list.push({
    instanceId: sa.instanceId,
    index,
    targetClaimNodeId: sa.verifyClaimNodeId,
    params: demoOpinionForClaim(
      sa.params.agentName,
      claim.index,
      index,
      sa.params.priority,
    ),
    dataPhase: 'workerOut',
  })
  state.opinions[sa.instanceId] = list
}

function findClaimByNodeId(state: InternalState, nodeId: string): InternalClaim | undefined {
  for (const [instanceId, cs] of Object.entries(state.claims)) {
    const c = cs.find(x => workerClaimNodeId(instanceId, x.index) === nodeId)
    if (c) return c
  }
  return undefined
}

let idCounter = 0
function randomInstanceId(prefix: string): string {
  idCounter += 1
  return `${prefix}#${idCounter}`
}

/** 仅测试用：重置内部 id 计数器，保证快照对比可重放。 */
export function __resetMockIdCounter(): void {
  idCounter = 0
}

export type { SubAgentEntry }
