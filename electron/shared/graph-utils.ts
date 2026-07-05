import { Send, getConfig, isGraphInterrupt } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ExecutionMode, MapSubAgentParams, AgentRuntimeConfig } from './types'
import { ErrorCode, errUpdateNormalize } from './errors'
import { NEWS_ROOT_ID, mapIdCreateRoute, mapIdUpdateInstance } from './map-ids'
import { promptRead, promptFormat } from './prompt-loader'
import {
  llmReadMessage,
  llmReadRoute,
  type SkillActivityCallback,
} from './llm-utils'

export const DEFAULT_MAX_CONCURRENCY = 3

const PRIORITY_ORDER: Record<MapSubAgentParams['priority'], number> = {
  high: 0,
  medium: 1,
  low: 2,
}

/** 按 priority 排序后截取，控制扇出并发数 */
export function graphReadRouteLimit(
  instructions: MapSubAgentParams[],
  maxConcurrency: number,
): MapSubAgentParams[] {
  return [...instructions]
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
    .slice(0, maxConcurrency)
}

export interface DynamicFanOutOptions {
  availableAgents: AgentRuntimeConfig[]
  maxConcurrency?: number
  subAgentNode?: string
  mergeNode?: string
}

/**
 * 动态扇出：基于路由指令创建 Send[]
 * 空路由时直接跳转 merge，避免图异常终止
 */
export function graphCreateFanout<T extends { routeInstructions: MapSubAgentParams[] }>(
  options: DynamicFanOutOptions,
) {
  const {
    availableAgents,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    subAgentNode = 'subAgent',
    mergeNode = 'merge',
  } = options

  const agentMap = new Map(availableAgents.map(agent => [agent.name, agent]))

  return (state: T): string | Send[] => {
    const validInstructions = state.routeInstructions.filter(
      instruction => agentMap.has(instruction.agentName),
    )

    if (validInstructions.length === 0) {
      return mergeNode
    }

    const limited = graphReadRouteLimit(validInstructions, maxConcurrency)

    return limited.map((instruction) => {
      const agentConfig = agentMap.get(instruction.agentName)!
      const threadId = getConfig()?.configurable?.thread_id as string | undefined
      return new Send(subAgentNode, {
        ...state,
        _agentConfig: agentConfig,
        _routeInstruction: instruction,
        _graphThreadId: threadId,
      })
    })
  }
}

/**
 * 通用 MainAgent route 节点。
 * 只跑 AI route；人工加槽在 confirmRoute 暂停点通过 updateState 写入，再扇出。
 */
export function graphCreateRoute<TState>(
  model: BaseChatModel,
  routePromptPath: string,
  availableAgents: AgentRuntimeConfig[],
  buildVars: (state: TState) => Record<string, string>,
) {
  return async (state: TState) => {
    const promptConfig = promptRead(routePromptPath)
    const agentList = availableAgents.map(a => `- ${a.name}`).join('\n')
    const prompt = promptFormat(promptConfig.content, {
      ...buildVars(state),
      availableAgents: agentList,
    })

    const response = await model.invoke(prompt)
    let routeInstructions = llmReadRoute(
      llmReadMessage(response.content),
      availableAgents,
    )

    if (routeInstructions.length === 0) {
      routeInstructions = availableAgents.map((agent, index) => ({
        agentName: agent.name,
        priority: (['high', 'medium', 'low'] as const)[Math.min(index, 2)],
      }))
    }

    return { routeInstructions: mapIdUpdateInstance(routeInstructions) }
  }
}

/**
 * 无 LLM 的固定路由 —— 用于 0-1 源→新闻 1:1 mock 解析槽。
 */
export function graphCreateMockRoute<TState>(
  seeds: Array<Pick<MapSubAgentParams, 'agentName' | 'priority' | 'instanceId' | 'hint'>>,
) {
  return async (_state: TState) => ({
    routeInstructions: mapIdUpdateInstance(seeds),
  })
}

/** route 与扇出之间的空节点，供 interruptBefore 做人审（改槽后再 fan-out）。 */
export async function graphUpdateRouteConfirm(): Promise<Record<string, never>> {
  return {}
}

export interface GraphInterruptCallbacks<TState> {
  onInterrupt: (
    currentState: TState,
    nextNode: string,
  ) => Promise<Partial<TState> | null>
}

interface CompiledGraph<TState> {
  invoke: (input: Partial<TState> | null, config: { configurable: { thread_id: string } }) => Promise<unknown>
  getState: (config: { configurable: { thread_id: string } }) => Promise<{ next?: string[]; values: unknown }>
  updateState: (
    config: { configurable: { thread_id: string } },
    update: Partial<TState>,
  ) => Promise<unknown>
}

/** 运行时会话 — 支持运行中随时切换 mode */
export type GraphProgressEventLocal = {
  event: 'node_enter' | 'node_exit' | 'fanout_spawn'
  node: string
  agentName?: string
  spawnIndex?: number
  nodeId?: string
  parentNodeId?: string
} | {
  event: 'subagent_tool'
  phase: 'start' | 'end'
  nodeId: string
  toolName: string
  argsSummary?: string
}

const sessionsByThread = new Map<string, GraphRunSession>()

export function graphRegisterSession(threadId: string, session: GraphRunSession): void {
  sessionsByThread.set(threadId, session)
}

export function graphDeleteSession(threadId: string): void {
  sessionsByThread.delete(threadId)
}

export function graphReadSession(threadId: string): GraphRunSession | undefined {
  return sessionsByThread.get(threadId)
}

/** SubAgent 节点：将 ReAct skill 活动桥接到 GraphRunSession.onProgress。 */
export function graphCreateSkillEmitter(
  instruction: Pick<MapSubAgentParams, 'instanceId'>,
  threadId: string | undefined,
  parentNodeId?: string,
): SkillActivityCallback {
  if (typeof threadId !== 'string') return () => {}

  const nodeId = mapIdCreateRoute(instruction, parentNodeId)

  return (activity) => {
    const session = graphReadSession(threadId)
    if (!session?.onProgress) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[graph] subagent_tool dropped: session not found', threadId)
      }
      return
    }

    if (activity.phase === 'start') {
      session.onProgress({
        event: 'subagent_tool',
        phase: 'start',
        nodeId,
        toolName: activity.toolName,
        argsSummary: activity.argsSummary,
      })
      return
    }

    session.onProgress({
      event: 'subagent_tool',
      phase: 'end',
      nodeId,
      toolName: activity.toolName,
    })
  }
}

export interface GraphRunSession {
  mode: ExecutionMode
  graph?: CompiledGraph<{ mode?: ExecutionMode }>
  config?: { configurable: { thread_id: string } }
  loadNode?: string
  onProgress?: (event: GraphProgressEventLocal) => void
  /** 每个节点执行后，将 checkpoint 投影到 Map */
  onStateProject?: (state: unknown, completedNode: string) => void
  fanoutEmitted?: boolean
  /** 扇出时 Map 节点 id（如 0-1 用 parse:{chainId} 而非 sub:） */
  fanoutReadNodeId?: (
    instruction: MapSubAgentParams,
    parentNodeId: string,
  ) => string
  /** 协作式取消：编排循环在安全点检查并退出 */
  cancelled?: boolean
  /** 稳定 thread id，用于断点恢复 */
  threadId?: string
}

/** 单步执行 LangGraph API，失败时规范为 AppError 并附带 failedNode。 */
async function graphStep<T>(failedNode: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    // interruptBefore / interrupt() 通过 GraphInterrupt 冒泡；invoke 通常会吞掉，
    // 若仍漏出则绝不能当成业务失败。
    if (isGraphInterrupt(error)) throw error
    throw errUpdateNormalize(error, ErrorCode.GRAPH_EXECUTION_FAILED, { failedNode })
  }
}

export interface RunGraphOptions {
  /** 从已 seed 的 checkpoint/state 恢复，跳过首段 load+route invoke */
  skipInitialInvoke?: boolean
}

async function graphNotifyStateProject<TState>(
  graph: CompiledGraph<TState>,
  config: { configurable: { thread_id: string } },
  session: GraphRunSession | undefined,
  completedNode: string,
): Promise<void> {
  if (!session?.onStateProject) return
  const snapshot = await graphStep('checkpoint', () => graph.getState(config))
  session.onStateProject(snapshot.values, completedNode)
}

/** HITL 编排循环 — auto / human-in-loop 模式通用 */
export async function graphRunInterrupt<TState extends { mode?: ExecutionMode }>(
  graph: CompiledGraph<TState>,
  input: Partial<TState>,
  callbacks: GraphInterruptCallbacks<TState>,
  threadId: string,
  session?: GraphRunSession,
  options?: RunGraphOptions,
): Promise<TState> {
  const config = { configurable: { thread_id: threadId } }

  if (session) {
    session.graph = graph as CompiledGraph<{ mode?: ExecutionMode }>
    session.config = config
    session.mode = input.mode ?? session.mode ?? 'auto'
    session.threadId = threadId
    graphRegisterSession(threadId, session)
  }

  try {
  if (!options?.skipInitialInvoke) {
    const initialMode = session?.mode ?? input.mode ?? 'auto'
    const loadLabel = session?.loadNode ?? 'load'

    // 首段 invoke 跑 load + route（route 含 LLM，可能较久）；失败时标 load 节点
    session?.onProgress?.({ event: 'node_enter', node: 'route' })
    await graphStep(loadLabel, () =>
      graph.invoke({ ...input, mode: initialMode } as Partial<TState>, config),
    )
    if (session?.cancelled) {
      return (await graph.getState(config)).values as TState
    }

    await graphNotifyStateProject(graph, config, session, 'route')

    if (session?.onProgress && session.loadNode) {
      session.onProgress({ event: 'node_exit', node: session.loadNode })
      session.onProgress({ event: 'node_exit', node: 'route' })
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (session?.cancelled) {
      return (await graph.getState(config)).values as TState
    }

    const snapshot = await graphStep('checkpoint', () => graph.getState(config))

    if (!snapshot.next || snapshot.next.length === 0) {
      if (session?.onProgress) {
        session.onProgress({ event: 'node_exit', node: 'save' })
      }
      return snapshot.values as TState
    }

    const currentState = snapshot.values as TState
    const nextNode = snapshot.next[0]
    const effectiveMode = session?.mode ?? currentState.mode ?? 'auto'

    if (session && effectiveMode !== currentState.mode) {
      await graphStep(nextNode, () =>
        graph.updateState(config, { mode: effectiveMode } as Partial<TState>),
      )
    }

    let stateAfterInterrupt = currentState

    if (effectiveMode === 'human-in-loop') {
      const modifications = await callbacks.onInterrupt(currentState, nextNode)
      // 取消：interrupt 返回后立刻退出，禁止继续 invoke
      if (session?.cancelled) {
        return currentState
      }
      if (modifications) {
        if (session && modifications.mode) {
          session.mode = modifications.mode
        }
        await graphStep(nextNode, () => graph.updateState(config, modifications))
        const updated = await graphStep('checkpoint', () => graph.getState(config))
        stateAfterInterrupt = updated.values as TState
      }
    }

    if (
      session?.onProgress
      && nextNode === 'confirmRoute'
      && !session.fanoutEmitted
      && typeof stateAfterInterrupt === 'object'
      && stateAfterInterrupt !== null
      && 'routeInstructions' in stateAfterInterrupt
    ) {
      const instructions = (stateAfterInterrupt as { routeInstructions: MapSubAgentParams[] }).routeInstructions
      const parentNodeId =
        typeof stateAfterInterrupt === 'object'
        && stateAfterInterrupt !== null
        && 'parentNodeId' in stateAfterInterrupt
        && typeof (stateAfterInterrupt as { parentNodeId?: string }).parentNodeId === 'string'
          ? (stateAfterInterrupt as { parentNodeId: string }).parentNodeId
          : NEWS_ROOT_ID
      instructions.forEach((instruction, index) => {
        const nodeId = session.fanoutReadNodeId
          ? session.fanoutReadNodeId(instruction, parentNodeId)
          : mapIdCreateRoute(instruction, parentNodeId)
        session.onProgress!({
          event: 'fanout_spawn',
          node: 'subAgent',
          agentName: instruction.agentName,
          spawnIndex: index,
          nodeId,
          parentNodeId,
        })
      })
      session.fanoutEmitted = true
    }

    session?.onProgress?.({ event: 'node_enter', node: nextNode })
    await graphStep(nextNode, () => graph.invoke(null, config))
    if (session?.cancelled) {
      return (await graph.getState(config)).values as TState
    }
    session?.onProgress?.({ event: 'node_exit', node: nextNode })
    await graphNotifyStateProject(graph, config, session, nextNode)
  }
  } finally {
    if (session) graphDeleteSession(threadId)
  }
}
