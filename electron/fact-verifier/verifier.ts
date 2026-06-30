import { Annotation, Send, StateGraph, START, END } from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  Confidence, ExecutionMode, RouteInstruction,
  SubAgentConfig, NewsContext,
} from '../shared/types'
import type { SubAgentOpinion, VerifyGraphConfig } from './types'
import { NewsModel } from '../fact-extractor/database'
import { loadPrompt, renderPrompt } from '../fact-extractor/prompt-loader'

// ==========================================
// State 定义
// ==========================================

const VerifyGraphState = Annotation.Root({
  // 输入
  newsId: Annotation<string>,
  claimId: Annotation<string>,

  /** 执行模式 — 可运行时通过 updateState 切换 */
  mode: Annotation<ExecutionMode>({
    value: (_prev, next) => next,
    default: () => 'auto' as ExecutionMode,
  }),

  // loadClaim 填充
  claimContent: Annotation<string>,
  originalContent: Annotation<string>,
  visibleContext: Annotation<Record<string, string>>({
    value: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),

  // MainAgent route 输出
  routeInstructions: Annotation<RouteInstruction[]>({
    value: (_prev, next) => next,
    default: () => [],
  }),

  // SubAgent 意见（reducer 合并并发写入）
  subAgentOpinions: Annotation<SubAgentOpinion[]>({
    value: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // MainAgent merge 输出（HITL 可调整 finalScore + finalReason）
  finalScore: Annotation<Confidence>({
    value: (_prev, next) => next,
    default: () => 0.5 as Confidence,
  }),
  finalReason: Annotation<string>({
    value: (_prev, next) => next,
    default: () => '',
  }),
  rawMergeResponse: Annotation<string>({
    value: (_prev, next) => next,
    default: () => '',
  }),
})

// ==========================================
// 工具函数
// ==========================================

function formatContext(ctx: Record<string, string>): string {
  return Object.entries(ctx)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

function extractVisibleContext(context: NewsContext): Record<string, string> {
  const visible: Record<string, string> = {}
  for (const [key, field] of Object.entries(context)) {
    if (field?.visibleToAI) {
      visible[key] = String(field.value)
    }
  }
  return visible
}

// ==========================================
// Node 实现
// ==========================================

/** 从 DB 加载 claim + 原文 + visibleContext */
async function loadClaim(state: typeof VerifyGraphState.State) {
  const doc = await NewsModel.findById(state.newsId)
  if (!doc) throw new Error(`News not found: ${state.newsId}`)

  const claims = doc.claims as unknown as Array<{ claimId: string; content: string }>
  const claim = claims.find(c => c.claimId === state.claimId)
  if (!claim) throw new Error(`Claim not found: ${state.claimId} in news ${state.newsId}`)

  const context = doc.context as unknown as NewsContext
  const visibleContext = extractVisibleContext(context)

  return {
    claimContent: claim.content,
    originalContent: doc.content,
    visibleContext,
  }
}

/** MainAgent Route：决定从哪些角度核查 */
function createVerifyRouteNode(
  model: BaseChatModel,
  routePromptPath: string,
  availableAgents: SubAgentConfig[],
) {
  return async (state: typeof VerifyGraphState.State) => {
    const promptConfig = loadPrompt(routePromptPath)
    const agentList = availableAgents.map(a => `- ${a.name}`).join('\n')
    const prompt = renderPrompt(promptConfig.content, {
      claimContent: state.claimContent,
      originalContent: state.originalContent,
      context: formatContext(state.visibleContext),
      availableAgents: agentList,
    })

    const response = await model.invoke(prompt)
    const instructions: RouteInstruction[] = JSON.parse(
      response.content as string,
    )

    const validPriorities = new Set(['high', 'medium', 'low'])
    const validNames = new Set(availableAgents.map(a => a.name))
    const routeInstructions = instructions.filter(
      i => validNames.has(i.agentName) && validPriorities.has(i.priority),
    )

    return { routeInstructions }
  }
}

/** 动态扇出 */
function dynamicFanOut(availableAgents: SubAgentConfig[]) {
  return (state: typeof VerifyGraphState.State) => {
    return state.routeInstructions.map((instruction) => {
      const agentConfig = availableAgents.find(
        a => a.name === instruction.agentName,
      )!
      return new Send('subAgent', {
        ...state,
        _agentConfig: agentConfig,
        _routeInstruction: instruction,
      })
    })
  }
}

/** SubAgent Node：核查视角，输出 opinion */
function createVerifySubAgentNode(defaultModel: BaseChatModel) {
  const validScores = new Set([1, 0.5, 0])

  return async (state: typeof VerifyGraphState.State) => {
    const agentConfig = (state as Record<string, unknown>)
      ._agentConfig as SubAgentConfig
    const instruction = (state as Record<string, unknown>)
      ._routeInstruction as RouteInstruction
    const promptConfig = loadPrompt(agentConfig.promptPath)

    const prompt = renderPrompt(promptConfig.content, {
      claimContent: state.claimContent,
      originalContent: state.originalContent,
      context: formatContext(state.visibleContext),
      hint: instruction.hint ?? '',
    })

    const model = agentConfig.model ?? defaultModel
    const tools = agentConfig.tools ?? []

    let rawResponse: string

    if (tools.length > 0) {
      const agent = createReactAgent({ llm: model, tools })
      const result = await agent.invoke({
        messages: [{ role: 'user', content: prompt }],
      })
      rawResponse = result.messages.at(-1)?.content as string
    } else {
      const response = await model.invoke(prompt)
      rawResponse = response.content as string
    }

    let opinion: { score: number; reason: string } = { score: 0.5, reason: '' }
    try {
      opinion = JSON.parse(rawResponse)
    } catch {
      // 保留 rawResponse 用于调试
    }

    // 校验 score 枚举
    const score = validScores.has(opinion.score)
      ? (opinion.score as Confidence)
      : (0.5 as Confidence)

    return {
      subAgentOpinions: [
        {
          agentName: agentConfig.name,
          priority: instruction.priority,
          score,
          reason: opinion.reason ?? '',
          rawResponse,
        },
      ],
    }
  }
}

/** MainAgent Merge：汇总所有角度的 opinions → 最终 score + reason */
function createVerifyMergeNode(model: BaseChatModel, mergePromptPath: string) {
  const validScores = new Set([1, 0.5, 0])

  return async (state: typeof VerifyGraphState.State) => {
    const promptConfig = loadPrompt(mergePromptPath)
    const opinionsText = state.subAgentOpinions
      .map(
        o =>
          `【${o.agentName}】(priority: ${o.priority})\n  score: ${o.score}\n  reason: ${o.reason}`,
      )
      .join('\n\n')

    const prompt = renderPrompt(promptConfig.content, {
      claimContent: state.claimContent,
      originalContent: state.originalContent,
      opinions: opinionsText,
    })

    const response = await model.invoke(prompt)
    const rawMergeResponse = response.content as string

    let result: { score: number; reason: string } = { score: 0.5, reason: '' }
    try {
      result = JSON.parse(rawMergeResponse)
    } catch {
      // 保留 rawMergeResponse 用于调试
    }

    const finalScore = validScores.has(result.score)
      ? (result.score as Confidence)
      : (0.5 as Confidence)

    return {
      finalScore,
      finalReason: result.reason ?? '',
      rawMergeResponse,
    }
  }
}

/** 写回核查结果到 claim 子文档 */
async function saveVerifyResult(state: typeof VerifyGraphState.State) {
  const doc = await NewsModel.findById(state.newsId)
  if (!doc) throw new Error(`News not found: ${state.newsId}`)

  const claims = doc.claims as unknown as Array<{
    claimId: string
    verifyResult?: unknown
  }>
  const claimIndex = claims.findIndex(c => c.claimId === state.claimId)
  if (claimIndex === -1) {
    throw new Error(`Claim not found: ${state.claimId}`)
  }

  claims[claimIndex].verifyResult = {
    score: state.finalScore,
    reason: state.finalReason,
    opinions: state.subAgentOpinions,
    rawMergeResponse: state.rawMergeResponse,
    verifiedAt: new Date(),
  }

  doc.markModified('claims')
  await doc.save()

  return {}
}

// ==========================================
// 图构建
// ==========================================

/**
 * 构建事实核查图
 *
 * 流程：loadClaim → route → 动态 Send[] subAgent ×N → merge → save
 * 始终编译全部中断点，mode 在 state 中运行时可切换
 */
export function buildVerifyGraph(config: VerifyGraphConfig) {
  const {
    defaultModel,
    availableAgents,
    routePromptPath,
    mergePromptPath,
  } = config

  const checkpointer = new MemorySaver()

  type NodeName = 'loadClaim' | 'route' | 'subAgent' | 'merge' | 'save'
  const interruptPoints: NodeName[] = ['subAgent', 'merge', 'save']

  return new StateGraph(VerifyGraphState)
    .addNode('loadClaim', loadClaim)
    .addNode(
      'route',
      createVerifyRouteNode(defaultModel, routePromptPath, availableAgents),
    )
    .addNode('subAgent', createVerifySubAgentNode(defaultModel))
    .addNode('merge', createVerifyMergeNode(defaultModel, mergePromptPath))
    .addNode('save', saveVerifyResult)
    .addEdge(START, 'loadClaim')
    .addEdge('loadClaim', 'route')
    .addConditionalEdges('route', dynamicFanOut(availableAgents))
    .addEdge('subAgent', 'merge')
    .addEdge('merge', 'save')
    .addEdge('save', END)
    .compile({ checkpointer, interruptBefore: interruptPoints })
}

// ==========================================
// 编排层
// ==========================================

export interface VerifyGraphCallbacks {
  /** HITL 暂停时调用，返回用户修改后的 state 片段（或 null 跳过修改） */
  onInterrupt: (
    currentState: typeof VerifyGraphState.State,
    nextNode: string,
  ) => Promise<Partial<typeof VerifyGraphState.State> | null>
}

/**
 * 运行核查图（编排层）
 *
 * 在每个中断点检查 state.mode：
 * - auto: 自动继续
 * - human-in-loop: 调用 callbacks.onInterrupt 等人审核
 */
export async function runVerifyGraph(
  graph: ReturnType<typeof buildVerifyGraph>,
  input: { newsId: string; claimId: string; mode?: ExecutionMode },
  callbacks: VerifyGraphCallbacks,
) {
  const threadId = `verify-${input.newsId}-${input.claimId}-${Date.now()}`
  const config = { configurable: { thread_id: threadId } }

  await graph.invoke(
    { newsId: input.newsId, claimId: input.claimId, mode: input.mode ?? 'auto' },
    config,
  )

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snapshot = await graph.getState(config)

    if (!snapshot.next || snapshot.next.length === 0) {
      return snapshot.values as typeof VerifyGraphState.State
    }

    const currentState = snapshot.values as typeof VerifyGraphState.State
    const nextNode = snapshot.next[0]

    if (currentState.mode === 'human-in-loop') {
      const modifications = await callbacks.onInterrupt(currentState, nextNode)
      if (modifications) {
        await graph.updateState(config, modifications)
      }
    }

    await graph.invoke(null, config)
  }
}
