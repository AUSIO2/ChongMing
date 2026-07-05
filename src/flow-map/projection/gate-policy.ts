import type { GraphInterruptNode } from '../../electron/api/types'

export type ProjWorkerMode = 'routesOnly' | 'draftFlags' | 'numberedPersist'

export interface ProjGatePolicy {
  pruneWorkerSubtree: boolean
  projectWorkerMode: ProjWorkerMode
}

export interface ProjUpdateContext {
  upcomingGate?: GraphInterruptNode
  completedNode?: string
}

export function projReadGatePolicy(gate: GraphInterruptNode): ProjGatePolicy {
  if (gate === 'confirmRoute') {
    return { pruneWorkerSubtree: true, projectWorkerMode: 'routesOnly' }
  }
  if (gate === 'validate') {
    return { pruneWorkerSubtree: false, projectWorkerMode: 'draftFlags' }
  }
  return { pruneWorkerSubtree: false, projectWorkerMode: 'numberedPersist' }
}

export function projCanPruneRoutes(ctx: ProjUpdateContext): boolean {
  if (ctx.upcomingGate === 'confirmRoute') return true
  if (ctx.completedNode === 'route') return true
  return false
}
