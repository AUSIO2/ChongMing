import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { getCheckpointer } from '../shared/checkpointer'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  MapSubAgentParams, GraphClaim,
  GraphSplitRecord, GraphConfig,
  ExecutionMode,
} from './types'
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
  parseClaimsArray,
  parseJsonFromLLM,
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
  if (!doc) {
    throw new AppError(ErrorCode.NEWS_NOT_FOUND, `News not found: ${state.newsId}`)
  }

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
          instanceId: instruction.instanceId,
          claims,
          rawResponse,
        },
      ],
    }
  }
}

/** 与 Map draft:N 同序的扁平草稿。 */
function flattenDraftClaims(state: typeof SplitGraphState.State): GraphClaim[] {
  return state.subAgentResults.flatMap(result =>
    result.claims.map(claim => ({
      content: claim.content,
      category: claim.category,
      sourceAgent: claim.sourceAgent ?? result.agentName,
      shouldSave: true,
    })),
  )
}

/** 解析 merge 返回的 shouldSave 标记数组（无 content 字段）。 */
function parseShouldSaveFlags(raw: string): Array<{ draftIndex?: number; shouldSave?: boolean }> {
  const parsed = parseJsonFromLLM<unknown>(raw)
  const candidates = Array.isArray(parsed) ? parsed : []
  return candidates.filter(
    (item): item is { draftIndex?: number; shouldSave?: boolean } =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  )
}

/** MainAgent Merge：只标记各草稿是否保留（shouldSave），不改写正文 / sourceAgent。 */
function createMergeNode(model: BaseChatModel, mergePromptPath: string) {
  return async (state: typeof SplitGraphState.State) => {
    const drafts = flattenDraftClaims(state)
    const promptConfig = loadPrompt(mergePromptPath)
    const subResultsText = drafts
      .map((c, i) => `[${i}] (${c.sourceAgent ?? '?'}) ${c.content}`)
      .join('\n')

    const prompt = renderPrompt(promptConfig.content, {
      content: state.content,
      subResults: subResultsText,
    })

    const rawMergeResponse = messageContentToString(
      (await model.invoke(prompt)).content,
    )

    const flags = parseShouldSaveFlags(rawMergeResponse)
    const byIndex = new Map<number, boolean>()
    flags.forEach((f, i) => {
      const idx = typeof f.draftIndex === 'number' ? f.draftIndex : i
      byIndex.set(idx, f.shouldSave !== false)
    })

    const mergedClaims = drafts.map((draft, i) => ({
      ...draft,
      shouldSave: byIndex.has(i) ? byIndex.get(i)! : true,
    }))

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
  if (!doc) {
    throw new AppError(ErrorCode.NEWS_NOT_FOUND, `News not found: ${state.newsId}`)
  }

  const claimId = mergedClaimNodeId(index)
  const existing = (doc.get('claims') as Array<{ claimId: string }> | undefined) ?? []
  if (!raw.sourceAgent) {
    throw new AppError(
      ErrorCode.GRAPH_EXECUTION_FAILED,
      `Claim missing sourceAgent at saveIndex ${index}`,
    )
  }
  const entry = {
    claimId,
    content: raw.content,
    category: raw.category,
    sourceAgent: raw.sourceAgent,
  }
  const nextClaims = existing.filter(c => c.claimId !== claimId)
  nextClaims.push(entry)
  // 保持 claimId 数字序
  nextClaims.sort((a, b) => Number(a.claimId) - Number(b.claimId))
  doc.set('claims', nextClaims)

  const nextIndex = index + 1
  if (nextIndex >= state.mergedClaims.length) {
    // 槽位历史 + SubAgent 产出，供 Map 从 DB 重建完整拓扑
    doc.set('splitMeta', {
      model: 'langgraph',
      routeInstructions: state.routeInstructions,
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
 * 流程：loadNews → route(AI) → confirmRoute（工具 invoke）→ subAgent×N
 *       → merge（LLM，只标 shouldSave，非 Map 节点）→ validate（工具）→ save（工具）
 * 正文须在 idle 编辑并落库后，再点运行触发 loadNews。
 */
export function buildSplitGraph(config: Omit<GraphConfig, 'mode'>) {
  const {
    defaultModel,
    availableAgents,
    routePromptPath,
    mergePromptPath,
    maxConcurrency,
  } = config

  const checkpointer = getCheckpointer()

  type NodeName =
    | 'loadNews'
    | 'route'
    | 'confirmRoute'
    | 'subAgent'
    | 'merge'
    | 'validate'
    | 'save'
  // 人审中断点 = 工具名（validate/save）或 confirmRoute→invoke；merge 仅 LLM，不中断
  const interruptPoints: NodeName[] = ['confirmRoute', 'validate', 'save']

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
    .addNode('confirmRoute', confirmRoutePassthrough)
    .addNode('subAgent', createSubAgentNode(defaultModel))
    .addNode('merge', createMergeNode(defaultModel, mergePromptPath))
    .addNode('validate', confirmRoutePassthrough)
    .addNode('save', saveOneClaim)
    .addEdge(START, 'loadNews')
    .addEdge('loadNews', 'route')
    .addEdge('route', 'confirmRoute')
    .addConditionalEdges(
      'confirmRoute',
      createDynamicFanOut({ availableAgents, maxConcurrency }),
    )
    .addEdge('subAgent', 'merge')
    .addEdge('merge', 'validate')
    .addEdge('validate', 'save')
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
    threadId?: string
  },
  callbacks: SplitGraphCallbacks,
  session?: GraphRunSession,
  options?: { skipInitialInvoke?: boolean },
) {
  const threadId = input.threadId ?? `split-${input.newsId}-${Date.now()}`

  return runGraphWithInterrupts(
    graph,
    {
      newsId: input.newsId,
      mode: input.mode ?? session?.mode ?? 'auto',
    },
    callbacks,
    threadId,
    session,
    options,
  )
}
