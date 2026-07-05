import { mapIdClaimBelongsToNews } from '../ids'
import type { TimelineScheduleSpec } from './types'
import { scheduleReadClaimScope } from './scope'

export const verifyScheduleSpec: TimelineScheduleSpec = {
  key: '2-3',

  readPending(ctx) {
    return ctx.claims
      .filter(c => !c.verifyResult)
      .map(c => ({
        parentNodeId: c.claimId,
        scopeNodeId: scheduleReadClaimScope(c.claimId)
          ?? (ctx.snapshot.nodes.find(
            n => n.kind === 'news'
              && mapIdClaimBelongsToNews(c.claimId, n.id),
          )?.id),
      }))
  },

  readInterruptStale(ctx, parentId) {
    const claim = ctx.claims.find(c => c.claimId === parentId)
    return !!claim?.verifyResult
  },
}
