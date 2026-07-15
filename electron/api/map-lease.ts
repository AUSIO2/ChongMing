import { MapModel } from '../shared/database'
import { clientReadId } from '../shared/client-identity'
import { AppError, ErrorCode } from '../shared/errors'

export const MAP_LEASE_TTL_MS = 30_000
export const MAP_LEASE_HEARTBEAT_MS = 10_000

export interface MapLeaseInfo {
  holderId: string
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  isMine: boolean
}

export interface MapLeaseAcquireResult {
  ok: boolean
  lease: MapLeaseInfo | null
}

type LeaseRaw = {
  holderId?: string
  acquiredAt?: Date
  heartbeatAt?: Date
}

const heldMapIds = new Set<string>()
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

function leaseIsExpired(heartbeatAt: Date | undefined, now = Date.now()): boolean {
  if (!heartbeatAt) return true
  return now - heartbeatAt.getTime() > MAP_LEASE_TTL_MS
}

function leaseReadInfo(raw: LeaseRaw | null | undefined, now = Date.now()): MapLeaseInfo | null {
  if (!raw?.holderId || !raw.heartbeatAt) return null
  if (leaseIsExpired(raw.heartbeatAt, now)) return null
  const me = clientReadId()
  const heartbeatAt = new Date(raw.heartbeatAt)
  const acquiredAt = raw.acquiredAt ? new Date(raw.acquiredAt) : heartbeatAt
  return {
    holderId: raw.holderId,
    acquiredAt: acquiredAt.toISOString(),
    heartbeatAt: heartbeatAt.toISOString(),
    expiresAt: new Date(heartbeatAt.getTime() + MAP_LEASE_TTL_MS).toISOString(),
    isMine: raw.holderId === me,
  }
}

function leaseTrack(mapId: string): void {
  heldMapIds.add(mapId)
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    void leaseHeartbeatAll()
  }, MAP_LEASE_HEARTBEAT_MS)
  if (typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
    heartbeatTimer.unref()
  }
}

function leaseUntrack(mapId: string): void {
  heldMapIds.delete(mapId)
  if (heldMapIds.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

async function leaseHeartbeatAll(): Promise<void> {
  const ids = [...heldMapIds]
  await Promise.all(ids.map(async (mapId) => {
    try {
      await mapLeaseHeartbeat(mapId)
    } catch {
      leaseUntrack(mapId)
    }
  }))
}

export async function mapLeaseStatus(mapId: string): Promise<MapLeaseInfo | null> {
  const doc = await MapModel.findById(mapId).select({ writeLease: 1 }).lean()
  if (!doc) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
  return leaseReadInfo(doc.writeLease as LeaseRaw | undefined)
}

export async function mapLeaseTryAcquire(mapId: string): Promise<MapLeaseAcquireResult> {
  const me = clientReadId()
  const now = new Date()
  const expiredBefore = new Date(now.getTime() - MAP_LEASE_TTL_MS)

  const result = await MapModel.updateOne(
    {
      _id: mapId,
      $or: [
        { writeLease: { $exists: false } },
        { writeLease: null },
        { 'writeLease.holderId': me },
        { 'writeLease.heartbeatAt': { $lt: expiredBefore } },
      ],
    },
    {
      $set: {
        writeLease: {
          holderId: me,
          acquiredAt: now,
          heartbeatAt: now,
        },
      },
    },
  )

  if (result.matchedCount === 0) {
    const exists = await MapModel.exists({ _id: mapId })
    if (!exists) {
      throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
    }
    const lease = await mapLeaseStatus(mapId)
    return { ok: false, lease }
  }

  leaseTrack(mapId)
  const lease = await mapLeaseStatus(mapId)
  return { ok: true, lease }
}

export async function mapLeaseHeartbeat(mapId: string): Promise<MapLeaseInfo> {
  const me = clientReadId()
  const now = new Date()
  const result = await MapModel.updateOne(
    {
      _id: mapId,
      'writeLease.holderId': me,
      'writeLease.heartbeatAt': { $gte: new Date(now.getTime() - MAP_LEASE_TTL_MS) },
    },
    { $set: { 'writeLease.heartbeatAt': now } },
  )
  if (result.matchedCount === 0) {
    leaseUntrack(mapId)
    throw new AppError(
      ErrorCode.MAP_LEASE_HELD,
      `Map lease not held by this client: ${mapId}`,
    )
  }
  leaseTrack(mapId)
  const lease = await mapLeaseStatus(mapId)
  if (!lease) {
    throw new AppError(ErrorCode.MAP_LEASE_HELD, `Map lease lost: ${mapId}`)
  }
  return lease
}

export async function mapLeaseRelease(mapId: string): Promise<void> {
  const me = clientReadId()
  await MapModel.updateOne(
    { _id: mapId, 'writeLease.holderId': me },
    { $unset: { writeLease: 1 } },
  )
  leaseUntrack(mapId)
}

/** 进程退出前释放本机持有的全部锁。 */
export async function mapLeaseReleaseAllHeld(): Promise<void> {
  const ids = [...heldMapIds]
  await Promise.all(ids.map(id => mapLeaseRelease(id)))
}

/** 写路径门禁：必须持有未过期的本机 lease。 */
export async function mapAssertWritable(mapId: string): Promise<void> {
  const me = clientReadId()
  const doc = await MapModel.findById(mapId).select({ writeLease: 1 }).lean()
  if (!doc) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
  const lease = leaseReadInfo(doc.writeLease as LeaseRaw | undefined)
  if (!lease || lease.holderId !== me) {
    throw new AppError(
      ErrorCode.MAP_LEASE_HELD,
      lease
        ? `Map is locked by another client (${lease.holderId.slice(0, 8)}…)`
        : `Map write requires an active lease: ${mapId}`,
    )
  }
}
