import { Send, isGraphInterrupt } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ExecutionMode, MapSubAgentParams, AgentRuntimeConfig } from './types'
import { ErrorCode, normalizeError } from './errors'
import { loadPrompt, renderPrompt } from './prompt-loader'
import { parseRouteInstructions, messageContentToString } from './llm-utils'

export const DEFAULT_MAX_CONCURRENCY = 3

const PRIORITY_ORDER: Record<MapSubAgentParams['priority'], number> = {
  high: 0,
  medium: 1,
  low: 2,
}

/** 按 priority 排序后截取，控制扇出并发数 */
export function limitRouteInstructions(
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
export function createDynamicFanOut<T extends { routeInstructions: MapSubAgentParams[] }>(
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

    const limited = limitRouteInstructions(validInstructions, maxConcurrency)

    return limited.map((instruction) => {
      const agentConfig = agentMap.get(instruction.agentName)!
      return new Send(subAgentNode, {
        ...state,
        _agentConfig: agentConfig,
        _routeInstruction: instruction,
      })
    })
  }
}

function withInstanceIds(instructions: MapSubAgentParams[]): MapSubAgentParams[] {
  return instructions.map((inst, index) => ({
    ...inst,
    instanceId: inst.instanceId ?? `${inst.agentName}#${index + 1}`,
  }))
}

/**
 * 通用 MainAgent route 节点。
 * 只跑 AI route；人工加槽在 confirmRoute 暂停点通过 updateState 写入，再扇出。
 */
export function createRouteNode<TState>(
  model: BaseChatModel,
  routePromptPath: string,
  availableAgents: AgentRuntimeConfig[],
  buildVars: (state: TState) => Record<string, string>,
) {
  return async (state: TState) => {
    const promptConfig = loadPrompt(routePromptPath)
    const agentList = availableAgents.map(a => `- ${a.name}`).join('\n')
    const prompt = renderPrompt(promptConfig.content, {
      ...buildVars(state),
      availableAgents: agentList,
    })

    const response = await model.invoke(prompt)
    let routeInstructions = parseRouteInstructions(
      messageContentToString(response.content),
      availableAgents,
    )

    if (routeInstructions.length === 0) {
      routeInstructions = availableAgents.map((agent, index) => ({
        agentName: agent.name,
        priority: (['high', 'medium', 'low'] as const)[Math.min(index, 2)],
      }))
    }

    return { routeInstructions: withInstanceIds(routeInstructions) }
  }
}

/** route 与扇出之间的空节点，供 interruptBefore 做人审（改槽后再 fan-out）。 */
export async function confirmRoutePassthrough(): Promise<Record<string, never>> {
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
export interface GraphProgressEventLocal {
  event: 'node_enter' | 'node_exit' | 'fanout_spawn'
  node: string
  agentName?: string
  spawnIndex?: number
}

export interface GraphRunSession {
  mode: ExecutionMode
  graph?: CompiledGraph<{ mode?: ExecutionMode }>
  config?: { configurable: { thread_id: string } }
  loadNode?: string
  onProgress?: (event: GraphProgressEventLocal) => void
  fanoutEmitted?: boolean
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
    throw normalizeError(error, ErrorCode.GRAPH_EXECUTION_FAILED, { failedNode })
  }
}

export interface RunGraphOptions {
  /** 从已 seed 的 checkpoint/state 恢复，跳过首段 load+route invoke */
  skipInitialInvoke?: boolean
}

/** HITL 编排循环 — auto / human-in-loop 模式通用 */
export async function runGraphWithInterrupts<TState extends { mode?: ExecutionMode }>(
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
  }

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

    if (
      session?.onProgress
      && nextNode === 'confirmRoute'
      && !session.fanoutEmitted
      && typeof currentState === 'object'
      && currentState !== null
      && 'routeInstructions' in currentState
    ) {
      const instructions = (currentState as { routeInstructions: MapSubAgentParams[] }).routeInstructions
      instructions.forEach((instruction, index) => {
        session.onProgress!({
          event: 'fanout_spawn',
          node: 'subAgent',
          agentName: instruction.agentName,
          spawnIndex: index,
        })
      })
      session.fanoutEmitted = true
    }

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
      }
    }

    session?.onProgress?.({ event: 'node_enter', node: nextNode })
    await graphStep(nextNode, () => graph.invoke(null, config))
    if (session?.cancelled) {
      return (await graph.getState(config)).values as TState
    }
    session?.onProgress?.({ event: 'node_exit', node: nextNode })
  }
}
