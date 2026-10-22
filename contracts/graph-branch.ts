// 定义分支范围与版本证明，以及编辑占有和 Run 控制租约。

// 人工编辑所依据的实际分支内容版本。null 只表示本次创建尚不存在的独立根。
export interface GraphBranchProof {
  rootIds: string[]
  expectedVersion: string | null
}

export interface GraphBranchLeaseProof {
  leaseId: string
  holderId: string
  fence: number
}

export interface GraphBranchScope {
  rootIds: string[]
  nodeIds: string[]
  edgeIds: string[]
}

export interface GraphBranchSnapshot {
  scope: GraphBranchScope
  version: string
  rootRevisions: Record<string, number>
  // 仅用于把读取到的分支证明与同一次公开图快照配对；并发裁决仍只比较 version。
  mapRevision: number
}

interface GraphBranchOwner {
  leaseId: string
  rootIds: string[]
  ownerUserId: string
  holderId: string
  fence: number
  runId?: string
  scope: GraphBranchScope
}

export type GraphBranchOwnership = GraphBranchOwner & (
  | { kind: 'editor'; expiresAt: string; leaseMs: number }
  | { kind: 'run'; expiresAt: null; leaseMs: null }
)

export type GraphBranchGrant = Extract<GraphBranchOwnership, { kind: 'editor' }> & {
  branch: GraphBranchSnapshot
  ownershipRevision: number
}

export type GraphBranchClaimResult =
  | { status: 'claimed'; grant: GraphBranchGrant }
  | { status: 'busy'; ownership: GraphBranchOwnership }

export interface GraphRunControlProof {
  leaseId: string
  holderId: string
  fence: number
}

// Run 范围占有属于后台运行；控制租约只授权一个客户端执行暂停、继续、取消和审核。
export interface GraphRunControl {
  leaseId: string
  runId: string
  ownerUserId: string
  holderId: string
  fence: number
  expiresAt: string
  leaseMs: number
}

export interface GraphRunControlGrant extends GraphRunControl {
  ownershipRevision: number
}

export type GraphRunControlClaimResult =
  | { status: 'claimed'; grant: GraphRunControlGrant }
  | { status: 'busy'; control: GraphRunControl }
