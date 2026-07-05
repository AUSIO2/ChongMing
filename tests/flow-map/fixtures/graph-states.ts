import { MAP_DEFAULT_NEWS_ID, mapIdCreateNews } from '@flow-map/ids'
import type {
  ExecutionMode,
  GraphParseState,
  GraphSplitState,
  GraphVerifyState,
} from '../../../electron/api/types'

export function testCreateSplitState(
  overrides: Partial<GraphSplitState> = {},
): GraphSplitState {
  return {
    mapId: 'n1',
    parentNodeId: MAP_DEFAULT_NEWS_ID,
    mode: 'human-in-loop',
    content: 'hello',
    visibleContext: {},
    routeInstructions: [{ agentName: '数据事实', priority: 'medium', instanceId: '数据事实#1' }],
    subAgentResults: [{
      agentName: '数据事实',
      priority: 'medium',
      instanceId: '数据事实#1',
      claims: [{ content: 'c1', sourceAgent: '数据事实' }],
      rawResponse: '',
    }],
    mergedClaims: [{ content: 'c1', sourceAgent: '数据事实', shouldSave: true }],
    rawMergeResponse: '',
    saveIndex: 0,
    ...overrides,
  }
}

export function testCreateParseState(
  parentNodeId: string,
  chainId: string,
  overrides: Partial<GraphParseState> = {},
): GraphParseState {
  const newsNodeId = mapIdCreateNews(chainId)
  return {
    mapId: 'n1',
    parentNodeId,
    newsNodeId,
    mode: 'human-in-loop',
    sourceUri: '/a.txt',
    sourceKind: 'file',
    rawContent: 'raw',
    routeInstructions: [{ agentName: 'parse', priority: 'medium', instanceId: 'parse#1' }],
    subAgentResults: [],
    parsedContent: '解析正文',
    ...overrides,
  }
}

export function testCreateVerifyState(
  claimId: string,
  scopeNodeId: string,
  overrides: Partial<GraphVerifyState> = {},
): GraphVerifyState {
  return {
    mapId: 'n1',
    parentNodeId: claimId,
    scopeNodeId,
    mode: 'human-in-loop',
    claimContent: 'c1',
    originalContent: 'hello',
    visibleContext: {},
    routeInstructions: [{ agentName: '来源可信度', priority: 'high', instanceId: '来源可信度#1' }],
    subAgentOpinions: [{
      agentName: '来源可信度',
      instanceId: '来源可信度#1',
      priority: 'high',
      score: 0.9,
      reason: 'ok',
      rawResponse: '',
    }],
    finalScore: 0.9,
    finalReason: 'ok',
    rawMergeResponse: '',
    opinionSaveIndex: 0,
    ...overrides,
  }
}

export function testReadMode(state: { mode?: ExecutionMode }): ExecutionMode {
  return state.mode ?? 'human-in-loop'
}
