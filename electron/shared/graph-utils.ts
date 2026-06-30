import { Send } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ExecutionMode, RouteInstruction, SubAgentConfig } from './types'
import { loadPrompt, renderPrompt } from './prompt-loader'
import { parseRouteInstructions, messageContentToString } from './llm-utils'

export const DEFAULT_MAX_CONCURRENCY = 3

const PRIORITY_ORDER: Record<RouteInstruction['priority'], number> = {
  high: 0,
  medium: 1,
  low: 2,
}

/** 按 priority 排序后截取，控制扇出并发数 */
export function limitRouteInstructions(
  instructions: RouteInstruction[],
  maxConcurrency: number,
): RouteInstruction[] {
  return [...instructions]
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
    .slice(0, maxConcurrency)
}

export interface DynamicFanOutOptions {
  availableAgents: SubAgentConfig[]
  maxConcurrency?: number
  subAgentNode?: string
  mergeNode?: string
}

/**
 * 动态扇出：基于路由指令创建 Send[]
 * 空路由时直接跳转 merge，避免图异常终止
 */
export function createDynamicFanOut<T extends { routeInstructions: RouteInstruction[] }>(
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

/** 通用 MainAgent route 节点 */
export function createRouteNode<TState>(
  model: BaseChatModel,
  routePromptPath: string,
  availableAgents: SubAgentConfig[],
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
    const routeInstructions = parseRouteInstructions(
      messageContentToString(response.content),
      availableAgents,
    )

    return { routeInstructions }
  }
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
  updateState: (config: { configurable: { thread_id: string } }, update: Partial<TState>) => Promise<unknown>
}

/** HITL 编排循环 — auto / human-in-loop 模式通用 */
export async function runGraphWithInterrupts<TState extends { mode?: ExecutionMode }>(
  graph: CompiledGraph<TState>,
  input: Partial<TState>,
  callbacks: GraphInterruptCallbacks<TState>,
  threadId: string,
): Promise<TState> {
  const config = { configurable: { thread_id: threadId } }

  await graph.invoke(input, config)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snapshot = await graph.getState(config)

    if (!snapshot.next || snapshot.next.length === 0) {
      return snapshot.values as TState
    }

    const currentState = snapshot.values as TState
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
