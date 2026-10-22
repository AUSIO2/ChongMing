// 定义面向客户端的图快照、查询、写命令和统一响应。
import type { GraphChanges, GraphEdge, GraphNode } from './graph'
import type {
  GraphBranchLeaseProof,
  GraphBranchOwnership,
  GraphBranchProof,
  GraphBranchSnapshot,
  GraphRunControl,
  GraphRunControlGrant,
  GraphRunControlProof,
} from './graph-branch'
import type { GraphRun, GraphRunPlan } from './graph-run'

export interface GraphSnapshot {
  mapId: string
  workspaceId: string
  revision: number
  name: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  runs: GraphRun[]
  ownershipRevision: number
  ownerships: GraphBranchOwnership[]
  runControls: GraphRunControl[]
  updatedAt: string
}

export interface GraphMapSummary {
  id: string
  workspaceId: string
  revision: number
  name: string
  nodeCount: number
  typeCounts: Record<string, number>
  updatedAt: string
}

export interface GraphWriteResult {
  snapshot: GraphSnapshot
  createdNodeIds: string[]
  createdEdgeIds: string[]
  // 仅当证明与返回 snapshot 属于同一次提交时提供；重放若已有更新则省略。
  branch?: GraphBranchSnapshot
  // run.start 成功时原子授予启动窗口；终态 Run 不返回控制租约。
  runControl?: GraphRunControlGrant
}

export type GraphQuery =
  | { method: 'map.list'; params: { workspaceId: string } }
  | { method: 'map.get'; params: { mapId: string } }
  | { method: 'branch.get'; params: { mapId: string; rootIds: string[] } }
  | { method: 'run.get'; params: { mapId: string; runId: string } }
  | { method: 'run.list'; params: { mapId: string; operationId?: string; cursor?: string; limit?: number } }
  | { method: 'run.publication.preview'; params: {
      mapId: string; runId: string; operationId: string; reviewId: string; expectedReviewRevision: number
    } }

export type GraphCommand =
  | { requestId: string; method: 'map.create'; params: { workspaceId: string; expectedRevision: number; id: string; name: string } }
  // 全图元数据命令不取得分支；有效占有或活动 Run 会阻止提交，旧版本不得覆盖。
  | { requestId: string; method: 'map.rename'; params: { mapId: string; expectedRevision: number; name: string } }
  | { requestId: string; method: 'map.delete'; params: { mapId: string; expectedRevision: number } }
  | { requestId: string; method: 'graph.apply'; params: { mapId: string; branch: GraphBranchProof; lease?: GraphBranchLeaseProof; changes: GraphChanges } }
  | { requestId: string; method: 'branch.claim'; params: { mapId: string; rootIds: string[]; holderId: string } }
  | { requestId: string; method: 'branch.renew'; params: { mapId: string; lease: GraphBranchLeaseProof } }
  | { requestId: string; method: 'branch.release'; params: { mapId: string; lease: GraphBranchLeaseProof } }
  | { requestId: string; method: 'run.control.claim'; params: { mapId: string; runId: string; holderId: string } }
  | { requestId: string; method: 'run.control.renew'; params: { mapId: string; runId: string; control: GraphRunControlProof } }
  | { requestId: string; method: 'run.control.release'; params: { mapId: string; runId: string; control: GraphRunControlProof } }
  | {
      requestId: string
      method: 'run.start'
      params: {
        mapId: string
        id: string
        branch: GraphBranchProof
        lease?: GraphBranchLeaseProof
        scope: { nodeIds: string[] }
        plan: GraphRunPlan
        regenerate?: boolean
        mode: 'auto' | 'human-in-loop'
      }
    }
  | { requestId: string; method: 'run.cancel'; params: { mapId: string; runId: string; control?: GraphRunControlProof } }
  | { requestId: string; method: 'run.pause'; params: { mapId: string; runId: string; control?: GraphRunControlProof } }
  | { requestId: string; method: 'run.resume'; params: { mapId: string; runId: string; control?: GraphRunControlProof } }
  | {
      requestId: string
      method: 'review.answer'
      params: {
        mapId: string
        runId: string
        operationId: string
        reviewId: string
        expectedReviewRevision: number
        decision: 'approve' | 'reject'
        // 仅约束新结果批准；省略时保留旧审核合同，规划和拒绝不要求预览。
        expectedPublicationVersion?: string
        control?: GraphRunControlProof
      }
    }

export interface GraphSuccess<T> {
  ok: true
  requestId: string
  replayed: boolean
  data: T
}

export interface GraphFailure {
  ok: false
  requestId: string
  error: { code: string; message: string; retryable: boolean; errorId: string; currentRevision?: number }
}
