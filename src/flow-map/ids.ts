/** 与 electron/shared/map-ids 同源，保证 focus / 投影 id 一致。 */
export {
  NEWS_ROOT_ID,
  subAgentId,
  mergedClaimNodeId,
  workerClaimNodeId,
  opinionNodeId,
  edgeId,
  verifyInstanceId,
} from '../../electron/shared/map-ids'

/** @deprecated 使用 workerClaimNodeId；保留别名以免外部旧引用断裂。 */
export { workerClaimNodeId as claimId } from '../../electron/shared/map-ids'

/** @deprecated 使用 opinionNodeId(claimId, index)。 */
export { opinionNodeId as opinionId } from '../../electron/shared/map-ids'
