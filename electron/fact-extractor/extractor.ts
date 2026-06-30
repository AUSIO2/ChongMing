import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  RouteInstruction, RawClaim,
  SubAgentSplitRecord, SplitGraphConfig,
  ExecutionMode,
} from './types'
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
  parseClaimsArray,
} from '../shared/llm-utils'

// ==========================================
// State 定义
// ==========================================

const SplitGraphState = Annotation.Root({
  newsId: Annotation<string>,

  /** 执行模式 — 可运行时通过 updateState 切换 */
  mode: Annotation<ExecutionMode>({
    value: (_prev, next) => next,
    default: () => 'auto' as ExecutionMode,
  }),

  content: Annotation<string>,
  visibleContext: Annotation<Record<string, string>>({
    value: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),

  routeInstructions: Annotation<RouteInstruction[]>({
    value: (_prev, next) => next,
    default: () => [],
  }),

  subAgentResults: Annotation<SubAgentSplitRecord[]>({
    value: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  mergedClaims: Annotation<RawClaim[]>({
    value: (_prev, next) => next,
    default: () => [],
  }),
  rawMergeResponse: Annotation<string>({
    value: (_prev, next) => next,
    default: () => '',
  }),
})

// ==========================================
// Node 实现
// ==========================================

/** 从 DB 加载文档，提取 visibleContext */
async function loadNews(state: typeof SplitGraphState.State) {
  const doc = await NewsModel.findById(state.newsId)
  if (!doc) throw new Error(`News not found: ${state.newsId}`)

  const context = readNewsContext(doc)
  const visibleContext = extractVisibleContext(context)

  return { content: doc.content, visibleContext }
}

/** SubAgent Node：per-agent model/tools + ReAct 循环 */
function createSubAgentNode(defaultModel: BaseChatModel) {
  return async (state: typeof SplitGraphState.State) => {
    const agentConfig = (state as Record<string, unknown>)
      ._agentConfig as import('../shared/types').SubAgentConfig
    const instruction = (state as Record<string, unknown>)
      ._routeInstruction as RouteInstruction
    const promptConfig = loadPrompt(agentConfig.promptPath)

    const prompt = renderPrompt(promptConfig.content, {
      content: state.content,
      context: formatContext(state.visibleContext),
      hint: instruction.hint ?? '',
    })

    const model = agentConfig.model ?? defaultModel
    const tools = agentConfig.tools ?? []
    const rawResponse = await invokeWithOptionalTools(model, tools, prompt)

    const claims = parseClaimsArray<RawClaim>(rawResponse)
      .map(c => ({ ...c, sourceAgent: agentConfig.name }))

    return {
      subAgentResults: [
        {
          agentName: agentConfig.name,
          priority: instruction.priority,
          claims,
          rawResponse,
        },
      ],
    }
  }
}

/** MainAgent Merge：汇总 SubAgent 结果 */
function createMergeNode(model: BaseChatModel, mergePromptPath: string) {
  return async (state: typeof SplitGraphState.State) => {
    const promptConfig = loadPrompt(mergePromptPath)
    const subResultsText = state.subAgentResults
      .map(
        r =>
          `【${r.agentName}】(priority: ${r.priority})\n${r.claims.map(c => `  - ${c.content}`).join('\n')}`,
      )
      .join('\n\n')

    const prompt = renderPrompt(promptConfig.content, {
      content: state.content,
      subResults: subResultsText,
    })

    const rawMergeResponse = messageContentToString(
      (await model.invoke(prompt)).content,
    )
    const mergedClaims = parseClaimsArray<RawClaim>(rawMergeResponse)

    return { mergedClaims, rawMergeResponse }
  }
}

/** 分配 claimId + 写回 MongoDB */
async function saveResults(state: typeof SplitGraphState.State) {
  const doc = await NewsModel.findById(state.newsId)
  if (!doc) throw new Error(`News not found: ${state.newsId}`)

  const claims = state.mergedClaims.map((raw, i) => ({
    claimId: String(i + 1),
    content: raw.content,
    category: raw.category,
    sourceAgent: raw.sourceAgent ?? 'merge',
  }))

  doc.set('claims', claims)
  doc.set('splitMeta', {
    model: 'langgraph',
    subAgentResults: state.subAgentResults,
    rawMergeResponse: state.rawMergeResponse,
    splitAt: new Date(),
  })
  await doc.save()

  return {}
}

// ==========================================
// 图构建
// ==========================================

/**
 * 构建事实拆分图
 *
 * 流程：loadNews → route → 动态 Send[] subAgent ×N → merge → save
 * 始终编译全部中断点，mode 在 state 中运行时可切换
 */
export function buildSplitGraph(config: Omit<SplitGraphConfig, 'mode'>) {
  const {
    defaultModel,
    availableAgents,
    routePromptPath,
    mergePromptPath,
    maxConcurrency,
  } = config

  const checkpointer = new MemorySaver()

  type NodeName = 'loadNews' | 'route' | 'subAgent' | 'merge' | 'save'
  const interruptPoints: NodeName[] = ['subAgent', 'merge', 'save']

  return new StateGraph(SplitGraphState)
    .addNode('loadNews', loadNews)
    .addNode(
      'route',
      createRouteNode<typeof SplitGraphState.State>(
        defaultModel,
        routePromptPath,
        availableAgents,
        state => ({
          content: state.content,
          context: formatContext(state.visibleContext),
        }),
      ),
    )
    .addNode('subAgent', createSubAgentNode(defaultModel))
    .addNode('merge', createMergeNode(defaultModel, mergePromptPath))
    .addNode('save', saveResults)
    .addEdge(START, 'loadNews')
    .addEdge('loadNews', 'route')
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

export interface SplitGraphCallbacks {
  /** HITL 暂停时调用，返回用户修改后的 state 片段（或 null 跳过修改） */
  onInterrupt: (
    currentState: typeof SplitGraphState.State,
    nextNode: string,
  ) => Promise<Partial<typeof SplitGraphState.State> | null>
}

/**
 * 运行拆分图（编排层）
 *
 * 在每个中断点检查 state.mode：
 * - auto: 自动继续
 * - human-in-loop: 调用 callbacks.onInterrupt 等人审核
 *
 * 用户可以在任意中断点通过 onInterrupt 修改 mode，下一个中断点立即生效。
 */
export async function runSplitGraph(
  graph: ReturnType<typeof buildSplitGraph>,
  input: { newsId: string; mode?: ExecutionMode },
  callbacks: SplitGraphCallbacks,
) {
  const threadId = `split-${input.newsId}-${Date.now()}`

  return runGraphWithInterrupts(
    graph,
    { newsId: input.newsId, mode: input.mode ?? 'auto' },
    callbacks,
    threadId,
  )
}
