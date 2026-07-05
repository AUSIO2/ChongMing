import { describe, expect, it } from 'vitest'
import { projCanPruneRoutes, projReadGatePolicy } from '@flow-map/projection/gate-policy'

describe('projReadGatePolicy', () => {
  it('confirmRoute prune；validate/save 不 prune', () => {
    expect(projReadGatePolicy('confirmRoute')).toEqual({
      pruneWorkerSubtree: true,
      projectWorkerMode: 'routesOnly',
    })
    expect(projReadGatePolicy('validate').pruneWorkerSubtree).toBe(false)
    expect(projReadGatePolicy('save').pruneWorkerSubtree).toBe(false)
  })
})

describe('projCanPruneRoutes', () => {
  it('仅 confirmRoute 或 completedNode=route 时 prune stale routes', () => {
    expect(projCanPruneRoutes({ upcomingGate: 'confirmRoute' })).toBe(true)
    expect(projCanPruneRoutes({ upcomingGate: 'validate' })).toBe(false)
    expect(projCanPruneRoutes({ completedNode: 'route' })).toBe(true)
  })
})
