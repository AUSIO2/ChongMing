import type {
  GraphInterruptNode,
  GraphType,
  NewsDocumentDTO,
  RawClaimDTO,
  SplitGraphStateDTO,
  SubAgentOpinionDTO,
  SubAgentSplitRecordDTO,
  VerifyGraphStateDTO,
} from '../../electron/api/types'
import type { FlowNodePhase, FlowNodeVM, PipelineStatus } from '../types/flow'
import { isClaimInList } from '../utils/claimMatch'
import { claimTypeLabel } from './useFlowClaimNodes'
import { parseRouteIndexFromNodeId, splitWorkerNodeId, subAgentNodeId } from '../utils/routeNodeId'

const HIDDEN_ROLES = new Set(['route', 'merge', 'save'])

type GraphUiStatus = 'idle' | 'running' | 'interrupted' | 'completed' | 'error'

export interface UnifiedFlowInput {
  news: NewsDocumentDTO | null
  graphState: SplitGraphStateDTO | VerifyGraphStateDTO | null
  graphType: GraphType | null
  runtimeNodes: FlowNodeVM[]
  pipelineStatus: PipelineStatus
  activeClaimId: string | null
  claimsToVerify: string[]
  commitMergedClaims?: RawClaimDTO[] | null
  isSplitCommitStep?: boolean
  graphStatus?: GraphUiStatus
  nextNode?: GraphInterruptNode | null
}

/** SubAgent 步进暂停时尚未产出 claim，不展示中间态 info 节点 */
function shouldShowPreBridgeSplitClaims(
  hasSavedClaims: boolean,
  splitCommit: boolean,
  graphStatus: GraphUiStatus | undefined,
  nextNode: GraphInterruptNode | null | undefined,
): boolean {
  if (hasSavedClaims || splitCommit) return false
  if (graphStatus === 'interrupted' && nextNode === 'subAgent') return false
  return true
}

function agent(
  id: string,
  kind: string,
  label: string,
  stage: FlowNodeVM['stage'],
  agentRole: FlowNodeVM['agentRole'],
  phase: FlowNodePhase,
  extra: Partial<FlowNodeVM> = {},
): FlowNodeVM {
  return {
    id,
    nodeCategory: 'agent',
    kind,
    label,
    stage,
    agentRole,
    phase,
    ...extra,
  }
}

function info(
  id: string,
  kind: string,
  label: string,
  stage: FlowNodeVM['stage'],
  infoType: FlowNodeVM['infoType'],
  phase: FlowNodePhase,
  extra: Partial<FlowNodeVM> = {},
): FlowNodeVM {
  return {
    id,
    nodeCategory: 'info',
    kind,
    label,
    stage,
    infoType,
    phase,
    ...extra,
  }
}

function isSplitState(s: SplitGraphStateDTO | VerifyGraphStateDTO): s is SplitGraphStateDTO {
  return 'mergedClaims' in s
}

function splitResults(
  news: NewsDocumentDTO | null,
  graphState: SplitGraphStateDTO | VerifyGraphStateDTO | null,
): SubAgentSplitRecordDTO[] {
  if (graphState && isSplitState(graphState)) return graphState.subAgentResults
  return news?.splitMeta?.subAgentResults ?? []
}

function runtimePhase(
  runtime: FlowNodeVM[],
  match: (n: FlowNodeVM) => boolean,
): FlowNodePhase | undefined {
  return runtime.find(match)?.phase
}

function overlaySplitAgent(
  node: FlowNodeVM,
  runtime: FlowNodeVM[],
  graphType: GraphType | null,
): FlowNodeVM {
  if (graphType !== 'split' && graphType !== null) return node
  if (node.agentRole === 'load') {
    const p = runtimePhase(runtime, n => n.kind === 'loadNews')
    if (p) return { ...node, phase: p }
  }
  if (node.agentRole === 'worker' && node.spawnIndex != null) {
    const p = runtimePhase(runtime, n => n.id === subAgentNodeId(node.spawnIndex!))
    if (p) return { ...node, phase: p }
  }
  if (node.agentRole === 'worker' && node.agentName) {
    const p = runtimePhase(runtime, n => n.id === `subAgent:${node.agentName}`)
    if (p) return { ...node, phase: p }
  }
  return node
}

function overlayVerifyWorker(
  node: FlowNodeVM,
  runtime: FlowNodeVM[],
  graphType: GraphType | null,
  activeClaimId: string | null,
): FlowNodeVM {
  if (graphType !== 'verify' || !activeClaimId || node.claimId !== activeClaimId) return node
  if (node.agentRole !== 'worker') return node
  if (node.spawnIndex != null) {
    const p = runtimePhase(runtime, n => n.id === subAgentNodeId(node.spawnIndex!))
    if (p) return { ...node, phase: p }
  }
  if (node.agentName) {
    const p = runtimePhase(runtime, n => n.id === `subAgent:${node.agentName}`)
    if (p) return { ...node, phase: p }
  }
  return node
}

/** 仅收集拆分阶段 Worker，绝不混入核查 subAgent */
interface SplitWorkerEntry {
  index: number
  agentName: string
}

function collectSplitWorkers(
  news: NewsDocumentDTO | null,
  graphState: SplitGraphStateDTO | VerifyGraphStateDTO | null,
  graphType: GraphType | null,
  runtimeNodes: FlowNodeVM[],
  hasSavedClaims: boolean,
  isRouteConfig: boolean,
): SplitWorkerEntry[] {
  let workers: SplitWorkerEntry[] = []

  if (graphState && isSplitState(graphState) && graphState.routeInstructions.length) {
    workers = graphState.routeInstructions.map((r, index) => ({
      index,
      agentName: r.agentName,
    }))
  } else {
    workers = splitResults(news, graphState).map((r, index) => ({
      index,
      agentName: r.agentName,
    }))
    if (graphType === 'split') {
      for (const rt of runtimeNodes) {
        if (rt.kind === 'subAgent' && rt.stage === 'split' && rt.spawnIndex != null && rt.agentName) {
          const existing = workers.find(w => w.index === rt.spawnIndex)
          if (existing) {
            existing.agentName = rt.agentName
          } else {
            workers.push({ index: rt.spawnIndex, agentName: rt.agentName })
          }
        }
      }
      workers.sort((a, b) => a.index - b.index)
    }
  }

  if (hasSavedClaims && news && !isRouteConfig) {
    const sources = new Set(
      news.claims
        .map(c => c.sourceAgent)
        .filter((s): s is string => !!s && s !== 'merge'),
    )
    return workers.filter(w => sources.has(w.agentName))
  }
  return workers
}

function verifyRouteWorkerPhase(
  routeIndex: number,
  runtime: FlowNodeVM[],
): FlowNodePhase {
  const rt = runtime.find(n => n.id === subAgentNodeId(routeIndex))
  return rt?.phase ?? 'paused'
}

function phaseFromWorker(
  parentId: string,
  nodes: FlowNodeVM[],
  runtime: FlowNodeVM[],
): FlowNodePhase {
  const parent = nodes.find(n => n.id === parentId)
  if (parent) {
    if (parent.phase === 'hidden') return 'hidden'
    return parent.phase === 'paused' ? 'done' : parent.phase
  }
  const routeIndex = parseRouteIndexFromNodeId(parentId)
  if (routeIndex != null) {
    const rt = runtime.find(n => n.id === subAgentNodeId(routeIndex))
    if (!rt || rt.phase === 'hidden') return 'hidden'
    return rt.phase === 'paused' ? 'done' : rt.phase
  }
  const legacyName = parentId.replace('split:worker:', '')
  const rt = runtime.find(n => n.id === `subAgent:${legacyName}`)
  if (!rt || rt.phase === 'hidden') return 'hidden'
  return rt.phase === 'paused' ? 'done' : rt.phase
}

function workerBasePhase(
  routeIndex: number,
  splitDone: boolean,
  runtime: FlowNodeVM[],
  graphType: GraphType | null,
): FlowNodePhase {
  if (graphType === 'split') {
    const rt = runtime.find(n => n.id === subAgentNodeId(routeIndex))
    if (rt) return rt.phase
  }
  return splitDone ? 'done' : 'hidden'
}

function shouldShowVerifyForClaim(
  claimId: string,
  news: NewsDocumentDTO,
  pipelineStatus: PipelineStatus,
  activeClaimId: string | null,
): boolean {
  const claim = news.claims.find(c => c.claimId === claimId)
  if (claim?.verifyResult) return true
  if (pipelineStatus === 'running' && activeClaimId === claimId) return true
  return false
}

function verifyOpinionsForClaim(
  claim: NewsDocumentDTO['claims'][number],
  graphState: SplitGraphStateDTO | VerifyGraphStateDTO | null,
  graphType: GraphType | null,
  activeClaimId: string | null,
): SubAgentOpinionDTO[] {
  if (claim.verifyResult?.opinions.length) return claim.verifyResult.opinions
  if (
    graphType === 'verify'
    && activeClaimId === claim.claimId
    && graphState
    && !isSplitState(graphState)
  ) {
    return graphState.subAgentOpinions
  }
  return []
}

export function buildUnifiedFlowNodes(input: UnifiedFlowInput): FlowNodeVM[] {
  const {
    news,
    graphState,
    graphType,
    runtimeNodes,
    pipelineStatus,
    activeClaimId,
    commitMergedClaims,
    isSplitCommitStep,
  } = input

  const nodes: FlowNodeVM[] = []
  const results = splitResults(news, graphState)
  const hasSavedClaims = (news?.claims.length ?? 0) > 0
  const splitDone = hasSavedClaims || !!news?.splitMeta
  const splitCommit = !!isSplitCommitStep && !hasSavedClaims
  const mergeDraft = splitCommit
    ? (commitMergedClaims ?? (graphState && isSplitState(graphState) ? graphState.mergedClaims : []))
    : []

  const isRouteConfig = input.graphStatus === 'interrupted' && input.nextNode === 'subAgent'

  const splitLoadPhase = runtimePhase(runtimeNodes, n => n.kind === 'loadNews')
    ?? (splitDone ? 'done' : graphType === 'split' ? 'hidden' : 'hidden')

  nodes.push(overlaySplitAgent(
    agent('split:load', 'loadNews', '加载新闻', 'split', 'load', splitLoadPhase),
    runtimeNodes,
    graphType,
  ))

  const workerList = graphType === 'verify' && isRouteConfig
    ? []
    : collectSplitWorkers(
      news,
      graphState,
      graphType,
      runtimeNodes,
      hasSavedClaims,
      isRouteConfig,
    )

  workerList.forEach(({ index, agentName }) => {
    const basePhase = workerBasePhase(index, splitDone, runtimeNodes, graphType)
    nodes.push(overlaySplitAgent(
      agent(
        splitWorkerNodeId(index),
        'subAgent',
        agentName,
        'split',
        'worker',
        basePhase,
        { agentName, spawnIndex: index },
      ),
      runtimeNodes,
      graphType,
    ))
  })

  if (
    isRouteConfig
    && graphType === 'verify'
    && graphState
    && !isSplitState(graphState)
  ) {
    graphState.routeInstructions.forEach((instruction, index) => {
      nodes.push(agent(
        subAgentNodeId(index),
        'subAgent',
        instruction.agentName,
        'verify',
        'worker',
        verifyRouteWorkerPhase(index, runtimeNodes),
        {
          agentName: instruction.agentName,
          spawnIndex: index,
          claimId: activeClaimId ?? undefined,
        },
      ))
    })
  }

  if (splitCommit) {
    results.forEach((result, resultIndex) => {
      const parentId = splitWorkerNodeId(resultIndex)
      result.claims.forEach((claim, i) => {
        const kept = isClaimInList(claim, mergeDraft)
        nodes.push(info(
          `info:claim:${resultIndex}:${i}`,
          'claim',
          claimTypeLabel(claim.category),
          'split',
          'claim',
          'done',
          {
            agentName: result.agentName,
            claimIndex: i,
            parentId,
            spawnIndex: i,
            pendingDelete: !kept,
          },
        ))
      })
    })

    let previewRow = 0
    for (const merged of mergeDraft) {
      const fromWorker = results.some(r => r.claims.some(c => isClaimInList(c, [merged])))
      if (fromWorker) continue
      nodes.push(info(
        `preview:merged:${previewRow}`,
        'claim',
        claimTypeLabel(merged.category),
        'split',
        'claim',
        'done',
        {
          isPreview: true,
          agentName: merged.sourceAgent,
          spawnIndex: results.length + previewRow,
        },
      ))
      previewRow++
    }
  } else if (shouldShowPreBridgeSplitClaims(
    hasSavedClaims,
    splitCommit,
    input.graphStatus,
    input.nextNode,
  )) {
    results.forEach((result, resultIndex) => {
      const parentId = splitWorkerNodeId(resultIndex)
      result.claims.forEach((claim, i) => {
        nodes.push(info(
          `info:claim:${resultIndex}:${i}`,
          'claim',
          claimTypeLabel(claim.category),
          'split',
          'claim',
          phaseFromWorker(parentId, nodes, runtimeNodes),
          {
            agentName: result.agentName,
            claimIndex: i,
            parentId,
            spawnIndex: i,
          },
        ))
      })
    })
  }

  const bridgeClaims = news?.claims ?? []
  bridgeClaims.forEach((claim, i) => {
    nodes.push(info(
      `bridge:claim:${claim.claimId}`,
      'claim',
      claimTypeLabel(claim.category),
      'split',
      'claim',
      'done',
      {
        claimId: claim.claimId,
        isBridge: true,
        spawnIndex: i,
        agentName: claim.sourceAgent,
      },
    ))
  })

  if (!news) return nodes.filter(n => !HIDDEN_ROLES.has(n.agentRole ?? ''))

  for (const claim of news.claims) {
    if (!shouldShowVerifyForClaim(claim.claimId, news, pipelineStatus, activeClaimId)) {
      continue
    }

    const opinions = verifyOpinionsForClaim(claim, graphState, graphType, activeClaimId)
    const verifyDone = !!claim.verifyResult
    const isActive = graphType === 'verify' && activeClaimId === claim.claimId

    opinions.forEach((op, i) => {
      const baseWorkerPhase: FlowNodePhase = verifyDone ? 'done' : isActive ? 'active' : 'hidden'
      nodes.push(overlayVerifyWorker(
        agent(
          `verify:worker:${claim.claimId}:${op.agentName}`,
          'subAgent',
          op.agentName,
          'verify',
          'worker',
          baseWorkerPhase,
          { agentName: op.agentName, claimId: claim.claimId, spawnIndex: i },
        ),
        runtimeNodes,
        graphType,
        activeClaimId,
      ))

      const workerNode = nodes[nodes.length - 1]
      const opinionPhase: FlowNodePhase = workerNode.phase === 'hidden' ? 'hidden' : verifyDone ? 'done' : workerNode.phase

      nodes.push(info(
        `info:opinion:${claim.claimId}:${op.agentName}`,
        'opinion',
        '意见',
        'verify',
        'opinion',
        opinionPhase === 'paused' ? 'done' : opinionPhase,
        {
          agentName: op.agentName,
          claimId: claim.claimId,
          parentId: `verify:worker:${claim.claimId}:${op.agentName}`,
          spawnIndex: i,
        },
      ))
    })
  }

  return nodes.filter(n => !HIDDEN_ROLES.has(n.agentRole ?? ''))
}

export function resolveUnifiedFlowNode(
  id: string | null,
  input: UnifiedFlowInput,
): FlowNodeVM | null {
  if (!id) return null
  return buildUnifiedFlowNodes(input).find(n => n.id === id) ?? null
}
