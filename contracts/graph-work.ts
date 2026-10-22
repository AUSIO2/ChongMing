// 定义 Work 身份与授权、Host 领取命令、获权数据读取和阶段提案。
import type { DefinitionRef, ExecutionAgentDefinition, ExecutionStageSpec, OutputContract } from './data-definition'
import type { GraphNode } from './graph'
import type { GraphCandidateRef, GraphPlanSlot, GraphProposedOutput, GraphStageResult } from './graph-run'
import type { EvidenceFrozenClaim } from './evidence-library'

// 已领取 Work 的可信阶段/槽位身份。Host 位置和业务类型都不参与身份判断。
export interface GraphWork {
  workId: string
  mapId: string
  runId: string
  operationId: string
  stageId: string
  slotId: string
  specHash: string
  priority: 'high' | 'medium' | 'low'
}

export interface GraphWorkProof { workId: string; holderId: string; fence: number }

export interface GraphWorkGrant extends GraphWork, GraphWorkProof {
  hostId: string
  expiresAt: string
  leaseMs: number
}

export type GraphWorkCommand =
  | { method: 'claim'; params: { hostId: string; holderId: string; mapId: string; workId: string; deploymentId: string } }
  | { method: 'read'; params: GraphWorkProof & { mapId: string } }
  | { method: 'renew'; params: GraphWorkProof & { mapId: string } }
  | { method: 'release'; params: GraphWorkProof & { mapId: string } }
  | { method: 'fail'; params: GraphWorkProof & { mapId: string; message: string } }

// data_read 只返回当前 Work 获权的投影、依赖结果和冻结合同。
export interface GraphDataRead {
  mapId: string
  runId: string
  operationId: string
  transitionRef: DefinitionRef
  specHash: string
  inputs: Record<string, Array<{ key: string; node: GraphNode }>>
  context: Record<string, Array<{ key: string; node: GraphNode }>>
  // 仅当前 Operation 步骤已获权的库材料，payload沿冻结定义投影。
  libraryClaims?: EvidenceFrozenClaim[]
  priorStageResults: GraphStageResult[]
  promptVariables: Record<string, string>
  stage: {
    id: string
    slotId: string
    agent: ExecutionAgentDefinition
    tools: Array<{ name: string; description: string }>
    plan?: ExecutionStageSpec['plan']
  }
  outputContract: OutputContract
  proposalId: string
  work: { id: string; stageId: string; slotId: string; specHash: string; status: 'ready' | 'accepted' }
}

export type GraphDataProposal = {
  mapId: string
  operationId: string
  id: string
  specHash: string
  reason: string
} & (
  | { kind: 'outputs'; outputs: GraphProposedOutput[] }
  | { kind: 'selection'; selection: GraphCandidateRef[] }
  | { kind: 'plan'; slots: GraphPlanSlot[] }
)
