import { readFile } from 'node:fs/promises'
import { END, Annotation } from '@langchain/langgraph'
import { MapModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import { graphCreateMockRoute } from '../shared/graph-utils'
import { graphBuildHitl } from '../shared/graph-hitl'
import { mapIdCreateNews, mapIdReadChain, mapIdReadSubAgentClaim } from '../shared/map-ids'
import { promptRead, promptFormat } from '../shared/prompt-loader'
import { llmReadMessage, llmRunInvoke } from '../shared/llm-utils'
import type { ExecutionMode, MapSubAgentParams } from '../shared/types'
import type { ParseGraphConfig } from './types'

const ParseGraphState = Annotation.Root({
  mapId: Annotation<string>,
  parentNodeId: Annotation<string>,
  newsNodeId: Annotation<string>,

  mode: Annotation<ExecutionMode>({
    value: (_prev, next) => next,
    default: () => 'auto' as ExecutionMode,
  }),

  sourceUri: Annotation<string>({
    value: (_prev, next) => next,
    default: () => '',
  }),
  sourceKind: Annotation<'file' | 'url'>({
    value: (_prev, next) => next,
    default: () => 'file' as const,
  }),
  rawContent: Annotation<string>({
    value: (_prev, next) => next,
    default: () => '',
  }),

  routeInstructions: Annotation<MapSubAgentParams[]>({
    value: (_prev, next) => next,
    default: () => [],
  }),

  subAgentResults: Annotation<import('../fact-extractor/types').GraphSplitRecord[]>({
    value: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  parsedContent: Annotation<string>({
    value: (_prev, next) => next,
    default: () => '',
  }),
})

type MapGraphNode = {
  id: string
  kind: string
  params?: { uri?: string; kind?: 'file' | 'url'; label?: string }
}

async function readSourceFile(uri: string): Promise<string> {
  return readFile(uri, 'utf-8')
}

async function loadSource(state: typeof ParseGraphState.State) {
  const doc = await MapModel.findById(state.mapId).lean()
  if (!doc) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${state.mapId}`)
  }

  const nodes = (doc.mapGraph as { nodes?: MapGraphNode[] } | undefined)?.nodes ?? []
  const sourceNode = nodes.find(n => n.id === state.parentNodeId && n.kind === 'source')
  if (!sourceNode?.params?.uri) {
    throw new AppError(
      ErrorCode.MAP_SCOPE_NOT_FOUND,
      `Source node not found: ${state.parentNodeId}`,
    )
  }

  const sourceKind = sourceNode.params.kind ?? 'file'
  const sourceUri = sourceNode.params.uri
  let rawContent = ''
  if (sourceKind === 'file') {
    rawContent = await readSourceFile(sourceUri)
  } else {
    throw new AppError(ErrorCode.GRAPH_EXECUTION_FAILED, 'URL source not supported yet')
  }

  const chainId = mapIdReadChain(state.parentNodeId)
  if (!chainId) {
    throw new AppError(ErrorCode.GRAPH_EXECUTION_FAILED, `Invalid source id: ${state.parentNodeId}`)
  }

  return {
    sourceUri,
    sourceKind,
    rawContent,
    newsNodeId: mapIdCreateNews(chainId),
  }
}

function createParseWorker(config: ParseGraphConfig) {
  return async (state: typeof ParseGraphState.State) => {
    const instruction = (state as Record<string, unknown>)
      ._routeInstruction as MapSubAgentParams
    const agentConfig = (state as Record<string, unknown>)
      ._agentConfig as { name: string }

    const promptConfig = promptRead(config.extractPromptPath)
    const prompt = promptFormat(promptConfig.content, {
      rawContent: state.rawContent,
    })
    const rawResponse = await llmRunInvoke(config.defaultModel, [], prompt)
    const parsedContent = llmReadMessage(rawResponse).trim() || state.rawContent.trim()

    return {
      subAgentResults: [
        {
          agentName: agentConfig?.name ?? instruction.agentName,
          priority: instruction.priority,
          instanceId: instruction.instanceId,
          claims: [{ content: parsedContent, sourceAgent: 'parse' }],
          rawResponse: llmReadMessage(rawResponse),
        },
      ],
    }
  }
}

async function mergeParse(state: typeof ParseGraphState.State) {
  const rows = mapIdReadSubAgentClaim(state.subAgentResults ?? [])
  const parsedContent = rows[0]?.content?.trim() ?? state.rawContent.trim()
  return { parsedContent }
}

async function saveNews(state: typeof ParseGraphState.State) {
  const doc = await MapModel.findById(state.mapId)
  if (!doc) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${state.mapId}`)
  }

  const chains = doc.get('chains') as Map<string, Record<string, unknown>>
  chains.set(state.newsNodeId, {
    content: state.parsedContent,
    context: new Map(),
    claims: [],
  })
  doc.markModified('chains')
  await doc.save()
  return {}
}

export function parseBuildGraph(config: ParseGraphConfig) {
  return graphBuildHitl({
    state: ParseGraphState,
    loadNode: 'loadSource',
    nodes: {
      load: loadSource,
      route: graphCreateMockRoute([{ agentName: 'parse', priority: 'medium', instanceId: 'parse#1' }]),
      subAgent: createParseWorker(config),
      merge: mergeParse,
      save: saveNews,
    },
    routeAfterSave: () => END,
    fanout: {
      availableAgents: [{
        name: 'parse',
        promptPath: config.extractPromptPath,
      }],
      maxConcurrency: 1,
    },
  })
}

export { ParseGraphState }
