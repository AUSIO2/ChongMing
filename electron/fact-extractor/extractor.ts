import { Annotation, END, getConfig } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  MapSubAgentParams, GraphClaim,
  GraphSplitRecord, GraphConfig,
  ExecutionMode,
} from './types'
import { MapModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import { ctxReadAiContext, ctxFormat } from '../shared/context'
import {
  mapChainRequireScope,
  mapChainWriteClaims,
} from '../api/map-chain-writers'
import {
  mapScopeReadContext,
  mapScopeRequire,
} from '../shared/map-scope'
import { llmResolvePromptModel } from '../shared/llm-model'
import { promptRead } from '../shared/prompt-loader'
import { promptReadKindForPath, promptRender, promptReadOutputParams } from '../shared/prompt-vars'
import { mapIdReadSubAgentClaim } from '../shared/map-ids'
import { mergeReadShouldSave, mergeUpdateClaims } from '../shared/merge-flags'
import {
  graphCreateRoute,
  graphCreateSkillEmitter,
  graphCreateDeltaEmitter,
  graphCreateAgentEmitter,
} from '../shared/graph-utils'
import { graphBuildHitl } from '../shared/graph-hitl'
import {
  llmRunInvoke,
  llmReadClaims,
} from '../shared/llm-utils'
import { mapIdCreateClaim, mapIdReadClaimSaveIndex } from '../shared/map-ids'

const SplitGraphState = Annotation.Root({
  mapId: Annotation<string>,
  parentNodeId: Annotation<string>,

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
  saveIndex: Annotation<number>({
    value: (_prev, next) => next,
    default: () => 0,
  }),
})

async function loadNews(state: typeof SplitGraphState.State) {
  const doc = await MapModel.findById(state.mapId)
  if (!doc) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${state.mapId}`)
  }

  const scope = mapScopeRequire(doc, state.parentNodeId)
  const visibleContext = ctxReadAiContext(mapScopeReadContext(scope))

  return { content: scope.content, visibleContext }
}

function createSubAgentNode(defaultModel: BaseChatModel) {
  return async (state: typeof SplitGraphState.State) => {
    const agentConfig = (state as Record<string, unknown>)
      ._agentConfig as import('../shared/types').AgentRuntimeConfig
    const instruction = (state as Record<string, unknown>)
      ._routeInstruction as MapSubAgentParams
    const promptConfig = promptRead(agentConfig.promptPath)

    const kind = promptReadKindForPath(agentConfig.promptPath)!
    const prompt = promptRender(
      promptConfig.content,
      promptConfig.promptVars,
      kind,
      {
        content: state.content,
        context: ctxFormat(state.visibleContext),
        hint: instruction.hint ?? '',
      },
      promptReadOutputParams(promptConfig, kind),
    )

    const model = agentConfig.model ?? defaultModel
    const tools = agentConfig.tools ?? []
    const threadId = (
      (state as Record<string, unknown>)._graphThreadId as string | undefined
    ) ?? (getConfig()?.configurable?.thread_id as string | undefined)
    const rawResponse = await llmRunInvoke(model, tools, prompt, {
      onSkillActivity: graphCreateSkillEmitter(
        instruction,
        threadId,
        state.parentNodeId,
      ),
      onDeltaActivity: graphCreateDeltaEmitter(
        instruction,
        threadId,
        state.parentNodeId,
      ),
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

function flattenDraftClaims(state: typeof SplitGraphState.State): GraphClaim[] {
  return mapIdReadSubAgentClaim(state.subAgentResults ?? []).map(row => ({
    content: row.content,
    category: row.category,
    sourceAgent: row.sourceAgent,
    shouldSave: true,
  }))
}

function createMergeNode(model: BaseChatModel, mergePromptPath: string) {
  return async (state: typeof SplitGraphState.State) => {
    const drafts = flattenDraftClaims(state)
    const promptConfig = promptRead(mergePromptPath)
    const mergeModel = llmResolvePromptModel(promptConfig, model)
    const subResultsText = drafts
      .map((c, i) => `[${i}] (${c.sourceAgent ?? '?'}) ${c.content}`)
      .join('\n')

    const prompt = promptRender(
      promptConfig.content,
      promptConfig.promptVars,
      promptReadKindForPath(mergePromptPath)!,
      {
        content: state.content,
        subResults: subResultsText,
      },
    )

    const threadId = getConfig()?.configurable?.thread_id as string | undefined
    const rawMergeResponse = await llmRunInvoke(mergeModel, [], prompt, {
      onDeltaActivity: graphCreateAgentEmitter('merge', threadId),
    })

    const flags = mergeReadShouldSave(rawMergeResponse)
    const mergedClaims = mergeUpdateClaims(drafts, flags)

    return { mergedClaims, rawMergeResponse, saveIndex: 0 }
  }
}

async function saveOneClaim(state: typeof SplitGraphState.State) {
  const index = state.saveIndex
  const raw = state.mergedClaims[index]
  if (!raw) return { saveIndex: index }

  const scope = await mapChainRequireScope(state.mapId, state.parentNodeId)

  const claimId = mapIdCreateClaim(index, state.parentNodeId)
  const existing = scope.claims ?? []
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
  nextClaims.sort(
    (a, b) =>
      (mapIdReadClaimSaveIndex(a.claimId) ?? 0) - (mapIdReadClaimSaveIndex(b.claimId) ?? 0),
  )

  const nextIndex = index + 1
  const splitMeta = nextIndex >= state.mergedClaims.length
    ? {
        model: 'langgraph',
        routeInstructions: state.routeInstructions,
        subAgentResults: state.subAgentResults,
        rawMergeResponse: state.rawMergeResponse,
        splitAt: new Date(),
      }
    : undefined

  await mapChainWriteClaims(state.mapId, state.parentNodeId, nextClaims, splitMeta)

  return { saveIndex: nextIndex }
}

function routeAfterSave(state: typeof SplitGraphState.State): string {
  if (state.saveIndex < state.mergedClaims.length) return 'save'
  return END
}

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
    routeAfterSave,
    fanout: { availableAgents, maxConcurrency },
  })
}

export { SplitGraphState }
