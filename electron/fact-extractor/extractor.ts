import { Annotation, Send, StateGraph, START, END } from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  SubAgentConfig, RouteInstruction, RawClaim,
  SubAgentSplitRecord, NewsContext, SplitGraphConfig,
  ExecutionMode,
} from './types'
import { NewsModel } from '../shared/database'
import { loadPrompt, renderPrompt } from '../shared/prompt-loader'

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
// 工具函数
// ==========================================

/** 将 visibleContext 格式化为文本 */
function formatContext(ctx: Record<string, string>): string {
  return Object.entries(ctx)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

/** 从 NewsContext 中提取 visibleToAI: true 的字段 */
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

/** 从 DB 加载文档，提取 visibleContext */
async function loadNews(state: typeof SplitGraphState.State) {
  const doc = await NewsModel.findById(state.newsId)
  if (!doc) throw new Error(`News not found: ${state.newsId}`)

  const context = doc.context as unknown as NewsContext
  const visibleContext = extractVisibleContext(context)

  return { content: doc.content, visibleContext }
}

/** MainAgent Route：返回结构化路由指令 */
function createRouteNode(
  model: BaseChatModel,
  routePromptPath: string,
  availableAgents: SubAgentConfig[],
) {
  return async (state: typeof SplitGraphState.State) => {
    const promptConfig = loadPrompt(routePromptPath)
    const agentList = availableAgents.map(a => `- ${a.name}`).join('\n')
    const prompt = renderPrompt(promptConfig.content, {
      content: state.content,
      context: formatContext(state.visibleContext),
      availableAgents: agentList,
    })

    const response = await model.invoke(prompt)
    const instructions: RouteInstruction[] = JSON.parse(
      response.content as string,
    )

    // 校验：只保留合法 agent + priority
    const validPriorities = new Set(['high', 'medium', 'low'])
    const validNames = new Set(availableAgents.map(a => a.name))
    const routeInstructions = instructions.filter(
      i => validNames.has(i.agentName) && validPriorities.has(i.priority),
    )

    return { routeInstructions }
  }
}

/** 动态扇出：基于路由指令创建 Send[] */
function dynamicFanOut(availableAgents: SubAgentConfig[]) {
  return (state: typeof SplitGraphState.State) => {
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

/** SubAgent Node：per-agent model/tools + ReAct 循环 */
function createSubAgentNode(defaultModel: BaseChatModel) {
  return async (state: typeof SplitGraphState.State) => {
    const agentConfig = (state as Record<string, unknown>)
      ._agentConfig as SubAgentConfig
    const instruction = (state as Record<string, unknown>)
      ._routeInstruction as RouteInstruction
    const promptConfig = loadPrompt(agentConfig.promptPath)

    // hint 注入 prompt
    const prompt = renderPrompt(promptConfig.content, {
      content: state.content,
      context: formatContext(state.visibleContext),
      hint: instruction.hint ?? '',
    })

    // 优先用 agent 自己的 model/tools
    const model = agentConfig.model ?? defaultModel
    const tools = agentConfig.tools ?? []

    let rawResponse: string

    if (tools.length > 0) {
      // 有 tools → ReAct agent
      const agent = createReactAgent({
        llm: model,
        tools,
      })
      const result = await agent.invoke({
        messages: [{ role: 'user', content: prompt }],
      })
      rawResponse = result.messages.at(-1)?.content as string
    } else {
      // 无 tools → 直接调用
      const response = await model.invoke(prompt)
      rawResponse = response.content as string
    }

    let claims: RawClaim[] = []
    try {
      claims = JSON.parse(rawResponse)
    } catch {
      // AI 返回非法 JSON，保留 rawResponse 用于调试
    }

    // 标记来源
    claims = claims.map(c => ({ ...c, sourceAgent: agentConfig.name }))

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

    const response = await model.invoke(prompt)
    const rawMergeResponse = response.content as string
    let mergedClaims: RawClaim[] = []
    try {
      mergedClaims = JSON.parse(rawMergeResponse)
    } catch {
      // 保留 rawMergeResponse 用于调试
    }

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
  } = config

  const checkpointer = new MemorySaver()

  // 始终在所有可审核节点前设置中断点
  // 运行时由 runSplitGraph 根据 state.mode 决定是否自动跳过
  type NodeName = 'loadNews' | 'route' | 'subAgent' | 'merge' | 'save'
  const interruptPoints: NodeName[] = ['subAgent', 'merge', 'save']

  return new StateGraph(SplitGraphState)
    .addNode('loadNews', loadNews)
    .addNode(
      'route',
      createRouteNode(defaultModel, routePromptPath, availableAgents),
    )
    .addNode('subAgent', createSubAgentNode(defaultModel))
    .addNode('merge', createMergeNode(defaultModel, mergePromptPath))
    .addNode('save', saveResults)
    .addEdge(START, 'loadNews')
    .addEdge('loadNews', 'route')
    .addConditionalEdges('route', dynamicFanOut(availableAgents))
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
  const config = { configurable: { thread_id: threadId } }

  // 首次调用
  await graph.invoke(
    { newsId: input.newsId, mode: input.mode ?? 'auto' },
    config,
  )

  // 循环处理中断点
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snapshot = await graph.getState(config)

    // 图已完成
    if (!snapshot.next || snapshot.next.length === 0) {
      return snapshot.values as typeof SplitGraphState.State
    }

    const currentState = snapshot.values as typeof SplitGraphState.State
    const nextNode = snapshot.next[0]

    if (currentState.mode === 'human-in-loop') {
      // HITL 模式：等人审核
      const modifications = await callbacks.onInterrupt(currentState, nextNode)
      if (modifications) {
        await graph.updateState(config, modifications)
      }
    }
    // auto 模式或 HITL 审核完毕：继续执行
    await graph.invoke(null, config)
  }
}
