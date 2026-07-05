/**
 * HITL LangGraph 拓扑工厂 — 仅边、interrupt、fanout；领域节点由调用方注入。
 * split / verify 各自保留 `*BuildGraph` 薄包装；禁止在此合并双域 state。
 */
import { START, StateGraph } from '@langchain/langgraph'
import { ckptRead } from './checkpointer'
import {
  graphCreateFanout,
  graphUpdateRouteConfirm,
  type DynamicFanOutOptions,
} from './graph-utils'

export const GRAPH_HITL_INTERRUPT = ['confirmRoute', 'validate', 'save'] as const

type GraphNodeFn<TState> = (
  state: TState,
) => Promise<Partial<TState>> | Partial<TState>

export interface GraphHitlBuildOptions<TState> {
  // LangGraph Annotation.Root 实例
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any
  loadNode: string
  nodes: {
    load: GraphNodeFn<TState>
    route: GraphNodeFn<TState>
    subAgent: GraphNodeFn<TState>
    merge: GraphNodeFn<TState>
    save: GraphNodeFn<TState>
    validate?: GraphNodeFn<TState>
  }
  routeAfterSave: (state: TState) => string
  fanout: DynamicFanOutOptions
}

/** 标准 HITL 流水线：load → route → confirmRoute → subAgent×N → merge → validate → save */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function graphBuildHitl<TState>(options: GraphHitlBuildOptions<TState>): any {
  const checkpointer = ckptRead()
  const validate = options.nodes.validate ?? graphUpdateRouteConfirm
  const loadNode = options.loadNode

  return new StateGraph(options.state)
    .addNode(loadNode, options.nodes.load)
    .addNode('route', options.nodes.route)
    .addNode('confirmRoute', graphUpdateRouteConfirm)
    .addNode('subAgent', options.nodes.subAgent)
    .addNode('merge', options.nodes.merge)
    .addNode('validate', validate)
    .addNode('save', options.nodes.save)
    .addEdge(START, loadNode)
    .addEdge(loadNode, 'route')
    .addEdge('route', 'confirmRoute')
    .addConditionalEdges('confirmRoute', graphCreateFanout(options.fanout) as never)
    .addEdge('subAgent', 'merge')
    .addEdge('merge', 'validate')
    .addEdge('validate', 'save')
    .addConditionalEdges('save', options.routeAfterSave as never)
    .compile({ checkpointer, interruptBefore: [...GRAPH_HITL_INTERRUPT] })
}
