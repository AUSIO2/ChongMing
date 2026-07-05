import type { TimelineScheduleSpec } from './types'
import { scheduleScopeNeedsSplit } from './scope'

export const splitScheduleSpec: TimelineScheduleSpec = {
  key: '1-2',

  readPending(ctx) {
    const items = []
    for (const node of ctx.snapshot.nodes) {
      if (node.kind !== 'news') continue
      if (!scheduleScopeNeedsSplit(ctx.snapshot, node.id, ctx.claims)) continue
      items.push({ parentNodeId: node.id, scopeNodeId: node.id })
    }
    return items
  },

  readInterruptStale(ctx, parentId) {
    return !scheduleScopeNeedsSplit(ctx.snapshot, parentId, ctx.claims)
  },
}
