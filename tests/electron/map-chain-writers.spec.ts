import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import {
  mapChainReadScope,
  mapChainWriteClaims,
  mapChainWriteContent,
  mapChainWriteScope,
  mapChainWriteVerifyResult,
} from '../../electron/api/map-chain-writers'
import { mapLeaseTryAcquire } from '../../electron/api/map-lease'
import { clientSetIdForTest } from '../../electron/shared/client-identity'
import { dbCreate, dbDelete, MapModel } from '../../electron/shared/database'

const MAP_ID = 'map-chain-writers-parallel'

describe('map-chain-writers', () => {
  beforeAll(async () => {
    clientSetIdForTest('test-client-writers')
    await dbCreate('memory')
  })

  beforeEach(async () => {
    await MapModel.deleteOne({ _id: MAP_ID })
    await MapModel.create({
      _id: MAP_ID,
      workspaceId: 'default',
      chains: {
        newsA: { content: 'a', context: {}, claims: [] },
        newsB: { content: 'b', context: {}, claims: [] },
      },
      timeline: { startX: 0, endX: 3, activeScope: 'newsA' },
    })
    await mapLeaseTryAcquire(MAP_ID)
  })

  afterAll(async () => {
    await MapModel.deleteOne({ _id: MAP_ID })
    clientSetIdForTest(null)
    await dbDelete()
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect()
    }
  })

  it('并发写不同 scope 的 claims 互不覆盖', async () => {
    await Promise.all([
      mapChainWriteClaims(MAP_ID, 'newsA', [
        { claimId: 'claim:newsA:0', content: 'from-A', sourceAgent: 'split#1' },
      ]),
      mapChainWriteClaims(MAP_ID, 'newsB', [
        { claimId: 'claim:newsB:0', content: 'from-B', sourceAgent: 'split#1' },
      ]),
    ])

    const scopeA = await mapChainReadScope(MAP_ID, 'newsA')
    const scopeB = await mapChainReadScope(MAP_ID, 'newsB')
    expect(scopeA?.claims).toEqual([
      expect.objectContaining({ claimId: 'claim:newsA:0', content: 'from-A' }),
    ])
    expect(scopeB?.claims).toEqual([
      expect.objectContaining({ claimId: 'claim:newsB:0', content: 'from-B' }),
    ])
  })

  it('writeVerifyResult 只更新单条 claim', async () => {
    await mapChainWriteClaims(MAP_ID, 'newsA', [
      { claimId: 'claim:newsA:0', content: 'from-A', sourceAgent: 'split#1' },
      { claimId: 'claim:newsA:1', content: 'second', sourceAgent: 'split#1' },
    ])

    await mapChainWriteVerifyResult(MAP_ID, 'newsA', 'claim:newsA:0', {
      score: 1,
      reason: 'ok',
      opinions: [],
    })

    const scope = await mapChainReadScope(MAP_ID, 'newsA')
    expect(scope?.claims?.[0]?.verifyResult).toMatchObject({ score: 1, reason: 'ok' })
    expect(scope?.claims?.[1]?.verifyResult).toBeUndefined()
  })

  it('writeScope / writeContent 路径更新', async () => {
    await mapChainWriteScope(MAP_ID, 'newsC', {
      content: 'parsed',
      context: {},
      claims: [],
    })
    const created = await mapChainReadScope(MAP_ID, 'newsC')
    expect(created?.content).toBe('parsed')

    await mapChainWriteContent(MAP_ID, 'newsC', { content: 'edited' })
    const updated = await mapChainReadScope(MAP_ID, 'newsC')
    expect(updated?.content).toBe('edited')
  })
})
