import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import {
  MAP_LEASE_TTL_MS,
  mapAssertWritable,
  mapLeaseSetIdForTest,
  mapLeaseRelease,
  mapLeaseStatus,
  mapLeaseTryAcquire,
} from '../../electron/api/map-lease'
import { AppError, ErrorCode } from '../../electron/shared/errors'
import { clientSetIdForTest } from '../../electron/shared/client-identity'
import { dbCreate, dbDelete, MapModel } from '../../electron/shared/database'

const MAP_ID = 'map-lease-test'

describe('map-lease', () => {
  beforeAll(async () => {
    await dbCreate('memory')
  })

  beforeEach(async () => {
    clientSetIdForTest('client-a')
    mapLeaseSetIdForTest('process-a')
    await MapModel.deleteOne({ _id: MAP_ID })
    await MapModel.create({
      _id: MAP_ID,
      workspaceId: 'default',
      timeline: { startX: 0, endX: 3, activeScope: '' },
    })
  })

  afterAll(async () => {
    clientSetIdForTest(null)
    mapLeaseSetIdForTest(null)
    await MapModel.deleteOne({ _id: MAP_ID })
    await dbDelete()
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect()
    }
  })

  it('互斥：B 无法抢 A 的未过期锁', async () => {
    const a = await mapLeaseTryAcquire(MAP_ID)
    expect(a.ok).toBe(true)

    clientSetIdForTest('client-b')
    mapLeaseSetIdForTest('process-b')
    const b = await mapLeaseTryAcquire(MAP_ID)
    expect(b.ok).toBe(false)
    expect(b.lease?.holderId).toBe('client-a')

    await expect(mapAssertWritable(MAP_ID)).rejects.toMatchObject({
      code: ErrorCode.MAP_LEASE_HELD,
    })
  })

  it('主动 release 后可再抢', async () => {
    await mapLeaseTryAcquire(MAP_ID)
    await mapLeaseRelease(MAP_ID)
    expect(await mapLeaseStatus(MAP_ID)).toBeNull()

    clientSetIdForTest('client-b')
    mapLeaseSetIdForTest('process-b')
    const b = await mapLeaseTryAcquire(MAP_ID)
    expect(b.ok).toBe(true)
    expect(b.lease?.holderId).toBe('client-b')
  })

  it('过期后可被接管', async () => {
    await mapLeaseTryAcquire(MAP_ID)
    const expiredAt = new Date(Date.now() - MAP_LEASE_TTL_MS - 1000)
    await MapModel.updateOne(
      { _id: MAP_ID },
      {
        $set: {
          'writeLease.heartbeatAt': expiredAt,
          'writeLease.acquiredAt': expiredAt,
        },
      },
    )

    clientSetIdForTest('client-b')
    mapLeaseSetIdForTest('process-b')
    const b = await mapLeaseTryAcquire(MAP_ID)
    expect(b.ok).toBe(true)
    expect(b.lease?.holderId).toBe('client-b')
  })

  it('持锁方可写', async () => {
    await mapLeaseTryAcquire(MAP_ID)
    await expect(mapAssertWritable(MAP_ID)).resolves.toBeUndefined()

    clientSetIdForTest('client-b')
    mapLeaseSetIdForTest('process-b')
    try {
      await mapAssertWritable(MAP_ID)
      expect.fail('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe(ErrorCode.MAP_LEASE_HELD)
    }
  })
})
