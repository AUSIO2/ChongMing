import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  Confidence, ExecutionMode, RouteInstruction,
} from '../shared/types'
import type { SubAgentOpinion, VerifyGraphConfig } from './types'
import { NewsModel } from '../shared/database'
import { extractVisibleContext, formatContext, readNewsContext } from '../shared/context'
import { loadPrompt, renderPrompt } from '../shared/prompt-loader'
import {
  createDynamicFanOut,
  createRouteNode,
  runGraphWithInterrupts,
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

  routeInstructions: Annotation<RouteInstruction[]>({
    value: (_prev, next) => next,
    default: () => [],
  }),

  subAgentOpinions: Annotation<SubAgentOpinion[]>({
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
  if (!doc) throw new Error(`News not found: ${state.newsId}`)

  const claims = doc.claims as unknown as Array<{ claimId: string; content: string }>
  const claim = claims.find(c => c.claimId === state.claimId)
  if (!claim) throw new Error(`Claim not found: ${state.claimId} in news ${state.newsId}`)

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
      ._agentConfig as import('../shared/types').SubAgentConfig
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
    const rawResponse = await invokeWithOptionalTools(model, tools, prompt)

    const opinion = parseJsonObjectFromLLM(
      rawResponse,
      { score: 0.5, reason: '' },
    )

    return {
      subAgentOpinions: [
        {
          agentName: agentConfig.name,
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

export function buildVerifyGraph(config: VerifyGraphConfig) {
  const {
    defaultModel,
    availableAgents,
    routePromptPath,
    mergePromptPath,
    maxConcurrency,
  } = config

  const checkpointer = new MemorySaver()

  type NodeName = 'loadClaim' | 'route' | 'subAgent' | 'merge' | 'save'
  const interruptPoints: NodeName[] = ['subAgent', 'merge', 'save']

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
    .addNode('subAgent', createVerifySubAgentNode(defaultModel))
    .addNode('merge', createVerifyMergeNode(defaultModel, mergePromptPath))
    .addNode('save', saveVerifyResult)
    .addEdge(START, 'loadClaim')
    .addEdge('loadClaim', 'route')
    .addConditionalEdges(
      'route',
      createDynamicFanOut({ availableAgents, maxConcurrency }),
    )
    .addEdge('subAgent', 'merge')
    .addEdge('merge', 'save')
    .addEdge('save', END)
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
  input: { newsId: string; claimId: string; mode?: ExecutionMode },
  callbacks: VerifyGraphCallbacks,
) {
  const threadId = `verify-${input.newsId}-${input.claimId}-${Date.now()}`

  return runGraphWithInterrupts(
    graph,
    {
      newsId: input.newsId,
      claimId: input.claimId,
      mode: input.mode ?? 'auto',
    },
    callbacks,
    threadId,
  )
}
