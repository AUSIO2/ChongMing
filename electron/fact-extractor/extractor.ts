import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  MapSubAgentParams, GraphClaim,
  GraphSplitRecord, GraphConfig,
  ExecutionMode,
} from './types'
import { NewsModel } from '../shared/database'
import { extractVisibleContext, formatContext, readNewsContext } from '../shared/context'
import { loadPrompt, renderPrompt } from '../shared/prompt-loader'
import {
  createDynamicFanOut,
  createRouteNode,
  runGraphWithInterrupts,
  type GraphRunSession,
} from '../shared/graph-utils'
import {
  invokeWithOptionalTools,
  messageContentToString,
  parseClaimsArray,
} from '../shared/llm-utils'
import { mergedClaimNodeId } from '../shared/map-ids'

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

  routeInstructions: Annotation<MapSubAgentParams[]>({
    value: (_prev, next) => next,
    default: () => [],
  }),

  subAgentResults: Annotation<GraphSplitRecord[]>({
    value: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  mergedClaims: Annotation<GraphClaim[]>({
    value: (_prev, next) => next,
    default: () => [],
  }),
  rawMergeResponse: Annotation<string>({
    value: (_prev, next) => next,
    default: () => '',
  }),
  /** 下一条待落盘的 mergedClaims 下标 */
  saveIndex: Annotation<number>({
    value: (_prev, next) => next,
    default: () => 0,
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
      ._agentConfig as import('../shared/types').AgentRuntimeConfig
    const instruction = (state as Record<string, unknown>)
      ._routeInstruction as MapSubAgentParams
    const promptConfig = loadPrompt(agentConfig.promptPath)

    const prompt = renderPrompt(promptConfig.content, {
      content: state.content,
      context: formatContext(state.visibleContext),
      hint: instruction.hint ?? '',
    })

    const model = agentConfig.model ?? defaultModel
    const tools = agentConfig.tools ?? []
    const rawResponse = await invokeWithOptionalTools(model, tools, prompt)

    const claims = parseClaimsArray<GraphClaim>(rawResponse)
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
    let mergedClaims = parseClaimsArray<GraphClaim>(rawMergeResponse)

    if (mergedClaims.length === 0 && state.subAgentResults.length > 0) {
      mergedClaims = state.subAgentResults.flatMap(result =>
        result.claims.map(claim => ({
          ...claim,
          sourceAgent: claim.sourceAgent ?? result.agentName,
        })),
      )
    }

    if (mergedClaims.length === 0 && state.content.trim()) {
      mergedClaims = state.content
        .split(/[。！？\n]/)
        .map(s => s.trim())
        .filter(s => s.length > 4)
        .slice(0, 3)
        .map(content => ({
          content: content.endsWith('。') ? content : `${content}。`,
          category: 'other',
          sourceAgent: 'fallback',
        }))
    }

    return { mergedClaims, rawMergeResponse, saveIndex: 0 }
  }
}

/**
 * 按条落盘：只写 mergedClaims[saveIndex] 一条，然后 saveIndex++。
 * interruptBefore save → 一次 interrupt 对应一个 claim。
 */
async function saveOneClaim(state: typeof SplitGraphState.State) {
  const index = state.saveIndex
  const raw = state.mergedClaims[index]
  if (!raw) return { saveIndex: index }

  const doc = await NewsModel.findById(state.newsId)
  if (!doc) throw new Error(`News not found: ${state.newsId}`)

  const claimId = mergedClaimNodeId(index)
  const existing = (doc.get('claims') as Array<{ claimId: string }> | undefined) ?? []
  const entry = {
    claimId,
    content: raw.content,
    category: raw.category,
    sourceAgent: raw.sourceAgent ?? 'merge',
  }
  const nextClaims = existing.filter(c => c.claimId !== claimId)
  nextClaims.push(entry)
  // 保持 claimId 数字序
  nextClaims.sort((a, b) => Number(a.claimId) - Number(b.claimId))
  doc.set('claims', nextClaims)

  const nextIndex = index + 1
  if (nextIndex >= state.mergedClaims.length) {
    doc.set('splitMeta', {
      model: 'langgraph',
      subAgentResults: state.subAgentResults,
      rawMergeResponse: state.rawMergeResponse,
      splitAt: new Date(),
    })
  }
  await doc.save()

  return { saveIndex: nextIndex }
}

function routeAfterSave(state: typeof SplitGraphState.State): string {
  if (state.saveIndex < state.mergedClaims.length) return 'save'
  return END
}

// ==========================================
// 图构建
// ==========================================

/**
 * 构建事实拆分图
 *
 * 流程：loadNews → route → subAgent×N → merge → save（按条循环）
 * interruptBefore save：每次只焦点一条 claim
 */
export function buildSplitGraph(config: Omit<GraphConfig, 'mode'>) {
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
    .addNode('save', saveOneClaim)
    .addEdge(START, 'loadNews')
    .addEdge('loadNews', 'route')
    .addConditionalEdges(
      'route',
      createDynamicFanOut({ availableAgents, maxConcurrency }),
    )
    .addEdge('subAgent', 'merge')
    .addEdge('merge', 'save')
    .addConditionalEdges('save', routeAfterSave)
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
  input: {
    newsId: string
    mode?: ExecutionMode
    /** 人工预置槽，与 AI route 合并 */
    routeInstructions?: MapSubAgentParams[]
  },
  callbacks: SplitGraphCallbacks,
  session?: GraphRunSession,
) {
  const threadId = `split-${input.newsId}-${Date.now()}`

  return runGraphWithInterrupts(
    graph,
    {
      newsId: input.newsId,
      mode: input.mode ?? session?.mode ?? 'auto',
      ...(input.routeInstructions?.length
        ? { routeInstructions: input.routeInstructions }
        : {}),
    },
    callbacks,
    threadId,
    session,
  )
}
