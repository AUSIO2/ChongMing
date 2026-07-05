import { Annotation, END, getConfig } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  MapSubAgentParams, GraphClaim,
  GraphSplitRecord, GraphConfig,
  ExecutionMode,
} from './types'
import { NewsModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import { ctxReadAiContext, ctxFormat, ctxReadNewsDoc } from '../shared/context'
import { promptRead, promptFormat } from '../shared/prompt-loader'
import { mapIdReadSubAgentClaim } from '../shared/map-ids'
import { mergeReadShouldSave, mergeUpdateClaims } from '../shared/merge-flags'
import {
  graphCreateRoute,
  graphCreateSkillEmitter,
} from '../shared/graph-utils'
import { graphBuildHitl } from '../shared/graph-hitl'
import {
  llmRunInvoke,
  llmReadMessage,
  llmReadClaims,
} from '../shared/llm-utils'
import { mapIdCreateClaim } from '../shared/map-ids'

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

  const context = ctxReadNewsDoc(doc)
  const visibleContext = ctxReadAiContext(context)

  return { content: doc.content, visibleContext }
}

/** SubAgent Node：per-agent model/tools + ReAct 循环 */
function createSubAgentNode(defaultModel: BaseChatModel) {
  return async (state: typeof SplitGraphState.State) => {
    const agentConfig = (state as Record<string, unknown>)
      ._agentConfig as import('../shared/types').AgentRuntimeConfig
    const instruction = (state as Record<string, unknown>)
      ._routeInstruction as MapSubAgentParams
    const promptConfig = promptRead(agentConfig.promptPath)

    const prompt = promptFormat(promptConfig.content, {
      content: state.content,
      context: ctxFormat(state.visibleContext),
      hint: instruction.hint ?? '',
    })

    const model = agentConfig.model ?? defaultModel
    const tools = agentConfig.tools ?? []
    const threadId = (
      (state as Record<string, unknown>)._graphThreadId as string | undefined
    ) ?? (getConfig()?.configurable?.thread_id as string | undefined)
    const rawResponse = await llmRunInvoke(model, tools, prompt, {
      onSkillActivity: graphCreateSkillEmitter(instruction, threadId),
    })

    const claims = llmReadClaims<GraphClaim>(rawResponse)
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
  return mapIdReadSubAgentClaim(state.subAgentResults ?? []).map(row => ({
    content: row.content,
    category: row.category,
    sourceAgent: row.sourceAgent,
    shouldSave: true,
  }))
}

/** MainAgent Merge：只标记各草稿是否保留（shouldSave），不改写正文 / sourceAgent。 */
function createMergeNode(model: BaseChatModel, mergePromptPath: string) {
  return async (state: typeof SplitGraphState.State) => {
    const drafts = flattenDraftClaims(state)
    const promptConfig = promptRead(mergePromptPath)
    const subResultsText = drafts
      .map((c, i) => `[${i}] (${c.sourceAgent ?? '?'}) ${c.content}`)
      .join('\n')

    const prompt = promptFormat(promptConfig.content, {
      content: state.content,
      subResults: subResultsText,
    })

    const rawMergeResponse = llmReadMessage(
      (await model.invoke(prompt)).content,
    )

    const flags = mergeReadShouldSave(rawMergeResponse)
    const mergedClaims = mergeUpdateClaims(drafts, flags)

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

  const claimId = mapIdCreateClaim(index)
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
export function splitBuildGraph(config: Omit<GraphConfig, 'mode'>) {
  const {
    defaultModel,
    availableAgents,
    routePromptPath,
    mergePromptPath,
    maxConcurrency,
  } = config

  return graphBuildHitl<typeof SplitGraphState.State>({
    state: SplitGraphState,
    loadNode: 'loadNews',
    nodes: {
      load: loadNews,
      route: graphCreateRoute<typeof SplitGraphState.State>(
        defaultModel,
        routePromptPath,
        availableAgents,
        state => ({
          content: state.content,
          context: ctxFormat(state.visibleContext),
        }),
      ),
      subAgent: createSubAgentNode(defaultModel),
      merge: createMergeNode(defaultModel, mergePromptPath),
      save: saveOneClaim,
    },
    routeAfterSave: routeAfterSave,
    fanout: { availableAgents, maxConcurrency },
  })
}
