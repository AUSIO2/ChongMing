import { Annotation, END, getConfig } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  Confidence, ExecutionMode, MapSubAgentParams,
} from '../shared/types'
import type { GraphOpinion, GraphConfig } from './types'
import { MapModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import { ctxReadAiContext, ctxFormat } from '../shared/context'
import {
  mapScopeReadContext,
  mapScopeReadKey,
  mapScopeRequire,
} from '../shared/map-scope'
import { promptRead, promptFormat } from '../shared/prompt-loader'
import {
  graphCreateRoute,
  graphCreateSkillEmitter,
} from '../shared/graph-utils'
import { graphBuildHitl } from '../shared/graph-hitl'
import {
  llmRunInvoke,
  llmReadMessage,
  llmReadJsonObject,
} from '../shared/llm-utils'

const VerifyGraphState = Annotation.Root({
  mapId: Annotation<string>,
  parentNodeId: Annotation<string>,
  scopeNodeId: Annotation<string>,

  mode: Annotation<ExecutionMode>({
    value: (_prev, next) => next,
    default: () => 'auto' as ExecutionMode,
  }),

  claimContent: Annotation<string>,
  originalContent: Annotation<string>,
  visibleContext: Annotation<Record<string, string>>({
    value: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),

  routeInstructions: Annotation<MapSubAgentParams[]>({
    value: (_prev, next) => next,
    default: () => [],
  }),

  subAgentOpinions: Annotation<GraphOpinion[]>({
    value: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  finalScore: Annotation<Confidence>({
    value: (_prev, next) => next,
    default: () => 0.5 as Confidence,
  }),
  finalReason: Annotation<string>({
    value: (_prev, next) => next,
    default: () => '',
  }),
  rawMergeResponse: Annotation<string>({
    value: (_prev, next) => next,
    default: () => '',
  }),
  opinionSaveIndex: Annotation<number>({
    value: (_prev, next) => next,
    default: () => 0,
  }),
})

const VALID_SCORES = new Set<number>([1, 0.5, 0])

function toConfidence(score: number): Confidence {
  return VALID_SCORES.has(score) ? (score as Confidence) : (0.5 as Confidence)
}

async function loadClaim(state: typeof VerifyGraphState.State) {
  const doc = await MapModel.findById(state.mapId)
  if (!doc) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${state.mapId}`)
  }

  const scope = mapScopeRequire(doc, state.scopeNodeId)
  const claims = scope.claims as Array<{ claimId: string; content: string }>
  const claim = claims.find(c => c.claimId === state.parentNodeId)
  if (!claim) {
    throw new AppError(
      ErrorCode.CLAIM_NOT_FOUND,
      `Claim not found: ${state.parentNodeId} in map ${state.mapId}`,
    )
  }

  const visibleContext = ctxReadAiContext(mapScopeReadContext(scope))

  return {
    claimContent: claim.content,
    originalContent: scope.content,
    visibleContext,
  }
}

function createVerifySubAgentNode(defaultModel: BaseChatModel) {
  return async (state: typeof VerifyGraphState.State) => {
    const agentConfig = (state as Record<string, unknown>)
      ._agentConfig as import('../shared/types').AgentRuntimeConfig
    const instruction = (state as Record<string, unknown>)
      ._routeInstruction as MapSubAgentParams
    const promptConfig = promptRead(agentConfig.promptPath)

    const prompt = promptFormat(promptConfig.content, {
      claimContent: state.claimContent,
      originalContent: state.originalContent,
      context: ctxFormat(state.visibleContext),
      hint: instruction.hint ?? '',
    })

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
    })

    const opinion = llmReadJsonObject(
      rawResponse,
      { score: 0.5, reason: '' },
    )

    return {
      subAgentOpinions: [
        {
          agentName: agentConfig.name,
          instanceId: instruction.instanceId,
          priority: instruction.priority,
          score: toConfidence(Number(opinion.score)),
          reason: typeof opinion.reason === 'string' ? opinion.reason : '',
          rawResponse,
        },
      ],
    }
  }
}

function createVerifyMergeNode(model: BaseChatModel, mergePromptPath: string) {
  return async (state: typeof VerifyGraphState.State) => {
    const promptConfig = promptRead(mergePromptPath)
    const opinionsText = state.subAgentOpinions
      .map(
        o =>
          `【${o.agentName}】(priority: ${o.priority})\n  score: ${o.score}\n  reason: ${o.reason}`,
      )
      .join('\n\n')

    const prompt = promptFormat(promptConfig.content, {
      claimContent: state.claimContent,
      originalContent: state.originalContent,
      opinions: opinionsText,
    })

    const response = await model.invoke(prompt)
    const rawMergeResponse = llmReadMessage(response.content)

    const result = llmReadJsonObject(
      rawMergeResponse,
      { score: 0.5, reason: '' },
    )

    return {
      finalScore: toConfidence(Number(result.score)),
      finalReason: typeof result.reason === 'string' ? result.reason : '',
      rawMergeResponse,
      opinionSaveIndex: 0,
    }
  }
}

async function saveOneOpinion(state: typeof VerifyGraphState.State) {
  const index = state.opinionSaveIndex
  const opinions = state.subAgentOpinions
  if (opinions.length === 0) {
    await writeVerifyResult(state, [])
    return { opinionSaveIndex: 0 }
  }
  if (index >= opinions.length) {
    return { opinionSaveIndex: index }
  }

  const confirmed = opinions.slice(0, index + 1)
  const isLast = index + 1 >= opinions.length
  await writeVerifyResult(state, confirmed, isLast)
  return { opinionSaveIndex: index + 1 }
}

async function writeVerifyResult(
  state: typeof VerifyGraphState.State,
  opinions: typeof state.subAgentOpinions,
  includeFinal = true,
) {
  const doc = await MapModel.findById(state.mapId)
  if (!doc) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${state.mapId}`)
  }

  const chains = doc.get('chains') as Map<string, Record<string, unknown>>
  const scope = chains.get(mapScopeReadKey(state.scopeNodeId))
  if (!scope) {
    throw new AppError(
      ErrorCode.MAP_SCOPE_NOT_FOUND,
      `Map scope not found: ${state.scopeNodeId}`,
    )
  }

  const claims = scope.claims as Array<{
    claimId: string
    verifyResult?: unknown
  }>
  const claimIndex = claims.findIndex(c => c.claimId === state.parentNodeId)
  if (claimIndex === -1) {
    throw new AppError(
      ErrorCode.CLAIM_NOT_FOUND,
      `Claim not found: ${state.parentNodeId}`,
    )
  }

  claims[claimIndex].verifyResult = {
    score: includeFinal ? state.finalScore : (claims[claimIndex].verifyResult as { score?: number } | undefined)?.score ?? 0.5,
    reason: includeFinal ? state.finalReason : (claims[claimIndex].verifyResult as { reason?: string } | undefined)?.reason ?? '',
    opinions,
    rawMergeResponse: state.rawMergeResponse,
    verifiedAt: new Date(),
  }

  doc.markModified('chains')
  await doc.save()
}

function routeAfterOpinionSave(state: typeof VerifyGraphState.State): string {
  if (state.opinionSaveIndex < state.subAgentOpinions.length) return 'save'
  return END
}

export function verifyBuildGraph(config: GraphConfig) {
  const {
    defaultModel,
    availableAgents,
    routePromptPath,
    mergePromptPath,
    maxConcurrency,
  } = config

  return graphBuildHitl<typeof VerifyGraphState.State>({
    state: VerifyGraphState,
    loadNode: 'loadClaim',
    nodes: {
      load: loadClaim,
      route: graphCreateRoute<typeof VerifyGraphState.State>(
        defaultModel,
        routePromptPath,
        availableAgents,
        state => ({
          claimContent: state.claimContent,
          originalContent: state.originalContent,
          context: ctxFormat(state.visibleContext),
        }),
      ),
      subAgent: createVerifySubAgentNode(defaultModel),
      merge: createVerifyMergeNode(defaultModel, mergePromptPath),
      save: saveOneOpinion,
    },
    routeAfterSave: routeAfterOpinionSave,
    fanout: { availableAgents, maxConcurrency },
  })
}

export { VerifyGraphState }
