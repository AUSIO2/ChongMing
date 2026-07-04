import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { getCheckpointer } from '../shared/checkpointer'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  Confidence, ExecutionMode, MapSubAgentParams,
} from '../shared/types'
import type { GraphOpinion, GraphConfig } from './types'
import { NewsModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import { extractVisibleContext, formatContext, readNewsContext } from '../shared/context'
import { loadPrompt, renderPrompt } from '../shared/prompt-loader'
import {
  confirmRoutePassthrough,
  createDynamicFanOut,
  createRouteNode,
  runGraphWithInterrupts,
  type GraphRunSession,
} from '../shared/graph-utils'
import {
  invokeWithOptionalTools,
  messageContentToString,
  parseJsonObjectFromLLM,
} from '../shared/llm-utils'

// ==========================================
// State 定义
// ==========================================

const VerifyGraphState = Annotation.Root({
  newsId: Annotation<string>,
  claimId: Annotation<string>,

  mode: Annotation<ExecutionMode>({
    value: (_prev, next) => next,
    default: () => 'auto' as ExecutionMode,
  }),

  claimContent: Annotation<string>,
  originalContent: Annotation<string>,
  visibleContext: Annotation<Record<string, string>>({
    value: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),

  routeInstructions: Annotation<MapSubAgentParams[]>({
    value: (_prev, next) => next,
    default: () => [],
  }),

  subAgentOpinions: Annotation<GraphOpinion[]>({
    value: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

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
  opinionSaveIndex: Annotation<number>({
    value: (_prev, next) => next,
    default: () => 0,
  }),
})

const VALID_SCORES = new Set<number>([1, 0.5, 0])

function toConfidence(score: number): Confidence {
  return VALID_SCORES.has(score) ? (score as Confidence) : (0.5 as Confidence)
}

// ==========================================
// Node 实现
// ==========================================

/** 从 DB 加载 claim + 原文 + visibleContext */
async function loadClaim(state: typeof VerifyGraphState.State) {
  const doc = await NewsModel.findById(state.newsId)
  if (!doc) {
    throw new AppError(ErrorCode.NEWS_NOT_FOUND, `News not found: ${state.newsId}`)
  }

  const claims = doc.claims as unknown as Array<{ claimId: string; content: string }>
  const claim = claims.find(c => c.claimId === state.claimId)
  if (!claim) {
    throw new AppError(
      ErrorCode.CLAIM_NOT_FOUND,
      `Claim not found: ${state.claimId} in news ${state.newsId}`,
    )
  }

  const context = readNewsContext(doc)
  const visibleContext = extractVisibleContext(context)

  return {
    claimContent: claim.content,
    originalContent: doc.content,
    visibleContext,
  }
}

/** SubAgent Node：核查视角，输出 opinion */
function createVerifySubAgentNode(defaultModel: BaseChatModel) {
  return async (state: typeof VerifyGraphState.State) => {
    const agentConfig = (state as Record<string, unknown>)
      ._agentConfig as import('../shared/types').AgentRuntimeConfig
    const instruction = (state as Record<string, unknown>)
      ._routeInstruction as MapSubAgentParams
    const promptConfig = loadPrompt(agentConfig.promptPath)

    const prompt = renderPrompt(promptConfig.content, {
      claimContent: state.claimContent,
      originalContent: state.originalContent,
      context: formatContext(state.visibleContext),
      hint: instruction.hint ?? '',
    })

    const model = agentConfig.model ?? defaultModel
    const tools = agentConfig.tools ?? []
    const rawResponse = await invokeWithOptionalTools(model, tools, prompt)

    const opinion = parseJsonObjectFromLLM(
      rawResponse,
      { score: 0.5, reason: '' },
    )

    return {
      subAgentOpinions: [
        {
          agentName: agentConfig.name,
          instanceId: instruction.instanceId,
          priority: instruction.priority,
          score: toConfidence(Number(opinion.score)),
          reason: typeof opinion.reason === 'string' ? opinion.reason : '',
          rawResponse,
        },
      ],
    }
  }
}

/** MainAgent Merge：汇总所有角度的 opinions → 最终 score + reason */
function createVerifyMergeNode(model: BaseChatModel, mergePromptPath: string) {
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
    const rawMergeResponse = messageContentToString(response.content)

    const result = parseJsonObjectFromLLM(
      rawMergeResponse,
      { score: 0.5, reason: '' },
    )

    return {
      finalScore: toConfidence(Number(result.score)),
      finalReason: typeof result.reason === 'string' ? result.reason : '',
      rawMergeResponse,
      opinionSaveIndex: 0,
    }
  }
}

/**
 * 按条确认 opinion：interruptBefore save 时焦点为 subAgentOpinions[opinionSaveIndex]。
 * 每确认一条写入已确认的 opinions 前缀；最后一条时写入完整 verifyResult。
 */
async function saveOneOpinion(state: typeof VerifyGraphState.State) {
  const index = state.opinionSaveIndex
  const opinions = state.subAgentOpinions
  if (opinions.length === 0) {
    await writeVerifyResult(state, [])
    return { opinionSaveIndex: 0 }
  }
  if (index >= opinions.length) {
    return { opinionSaveIndex: index }
  }

  const confirmed = opinions.slice(0, index + 1)
  const isLast = index + 1 >= opinions.length
  await writeVerifyResult(state, confirmed, isLast)
  return { opinionSaveIndex: index + 1 }
}

async function writeVerifyResult(
  state: typeof VerifyGraphState.State,
  opinions: typeof state.subAgentOpinions,
  includeFinal = true,
) {
  const doc = await NewsModel.findById(state.newsId)
  if (!doc) {
    throw new AppError(ErrorCode.NEWS_NOT_FOUND, `News not found: ${state.newsId}`)
  }

  const claims = doc.claims as unknown as Array<{
    claimId: string
    verifyResult?: unknown
  }>
  const claimIndex = claims.findIndex(c => c.claimId === state.claimId)
  if (claimIndex === -1) {
    throw new AppError(
      ErrorCode.CLAIM_NOT_FOUND,
      `Claim not found: ${state.claimId}`,
    )
  }

  claims[claimIndex].verifyResult = {
    score: includeFinal ? state.finalScore : (claims[claimIndex].verifyResult as { score?: number } | undefined)?.score ?? 0.5,
    reason: includeFinal ? state.finalReason : (claims[claimIndex].verifyResult as { reason?: string } | undefined)?.reason ?? '',
    opinions,
    rawMergeResponse: state.rawMergeResponse,
    verifiedAt: new Date(),
  }

  doc.markModified('claims')
  await doc.save()
}

function routeAfterOpinionSave(state: typeof VerifyGraphState.State): string {
  if (state.opinionSaveIndex < state.subAgentOpinions.length) return 'save'
  return END
}

// ==========================================
// 图构建
// ==========================================

export function buildVerifyGraph(config: GraphConfig) {
  const {
    defaultModel,
    availableAgents,
    routePromptPath,
    mergePromptPath,
    maxConcurrency,
  } = config

  const checkpointer = getCheckpointer()

  type NodeName =
    | 'loadClaim'
    | 'route'
    | 'confirmRoute'
    | 'subAgent'
    | 'merge'
    | 'validate'
    | 'save'
  // 人审中断点 = 工具；merge 仅 LLM，不中断、不投影为 Map 节点
  const interruptPoints: NodeName[] = ['confirmRoute', 'validate', 'save']

  return new StateGraph(VerifyGraphState)
    .addNode('loadClaim', loadClaim)
    .addNode(
      'route',
      createRouteNode<typeof VerifyGraphState.State>(
        defaultModel,
        routePromptPath,
        availableAgents,
        state => ({
          claimContent: state.claimContent,
          originalContent: state.originalContent,
          context: formatContext(state.visibleContext),
        }),
      ),
    )
    .addNode('confirmRoute', confirmRoutePassthrough)
    .addNode('subAgent', createVerifySubAgentNode(defaultModel))
    .addNode('merge', createVerifyMergeNode(defaultModel, mergePromptPath))
    .addNode('validate', confirmRoutePassthrough)
    .addNode('save', saveOneOpinion)
    .addEdge(START, 'loadClaim')
    .addEdge('loadClaim', 'route')
    .addEdge('route', 'confirmRoute')
    .addConditionalEdges(
      'confirmRoute',
      createDynamicFanOut({ availableAgents, maxConcurrency }),
    )
    .addEdge('subAgent', 'merge')
    .addEdge('merge', 'validate')
    .addEdge('validate', 'save')
    .addConditionalEdges('save', routeAfterOpinionSave)
    .compile({ checkpointer, interruptBefore: interruptPoints })
}

// ==========================================
// 编排层
// ==========================================

export interface VerifyGraphCallbacks {
  onInterrupt: (
    currentState: typeof VerifyGraphState.State,
    nextNode: string,
  ) => Promise<Partial<typeof VerifyGraphState.State> | null>
}

export async function runVerifyGraph(
  graph: ReturnType<typeof buildVerifyGraph>,
  input: {
    newsId: string
    claimId: string
    mode?: ExecutionMode
    threadId?: string
  },
  callbacks: VerifyGraphCallbacks,
  session?: GraphRunSession,
  options?: { skipInitialInvoke?: boolean },
) {
  const threadId =
    input.threadId ?? `verify-${input.newsId}-${input.claimId}-${Date.now()}`

  return runGraphWithInterrupts(
    graph,
    {
      newsId: input.newsId,
      claimId: input.claimId,
      mode: input.mode ?? session?.mode ?? 'auto',
    },
    callbacks,
    threadId,
    session,
    options,
  )
}
