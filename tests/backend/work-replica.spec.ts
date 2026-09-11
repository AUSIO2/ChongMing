import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { mongo, type Connection } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { describe, expect, it } from 'vitest'
import { graphCreateService, type GraphService } from '../../backend/graph'
import { storeCreateConnection, storeCreateGraphStore, storeDeleteConnection } from '../../backend/store'
import { DEVELOPMENT_WORKSPACE_ID, type GraphDataProposal, type GraphWorkGrant } from '../../contracts/graph'
import { verificationConfiguration, verificationSlots } from './fixtures/verification'

function replicaReadProof(grant: GraphWorkGrant) {
  return { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence }
}

async function replicaReadGrant(service: GraphService, mapId: string, hostId: string): Promise<GraphWorkGrant> {
  const grant = await service.dispatchWork({ method: 'claim', params: { mapId, hostId, holderId: randomUUID() } })
  if (!grant || !('actor' in grant)) throw new Error('Expected a claimed work grant')
  return grant
}

async function replicaReadReport(service: GraphService, grant: GraphWorkGrant): Promise<GraphDataProposal> {
  const actor = grant.actor
  if (actor.role !== 'worker') throw new Error('Expected worker work')
  const data = await service.readData(grant.mapId, grant.operationId, replicaReadProof(grant))
  if (!data.route) throw new Error('Worker has no route')
  return {
    mapId: grant.mapId, operationId: grant.operationId, id: data.proposalId,
    kind: 'report', routeRevision: data.route.revision, slotId: actor.slotId,
    score: 1, reason: `Durable evidence for ${actor.slotId}`,
  }
}

async function replicaReadPrimary(connection: Connection, previous?: string): Promise<string> {
  const deadline = Date.now() + 20_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const hello = await connection.db!.admin().command({ hello: 1 })
      if (hello.isWritablePrimary === true && typeof hello.me === 'string' && hello.me !== previous) return hello.me
    } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`Replica set did not elect a different writable primary: ${String(lastError ?? previous)}`)
}

describe('Work leases across a Mongo primary election', () => {
  it('preserves majority-confirmed reports and fences, then fences the expired holder after takeover', async () => {
    const replica = new MongoMemoryReplSet({ replSet: {
      count: 3, storageEngine: 'wiredTiger', name: `work-replica-${randomUUID()}`,
      configSettings: { electionTimeoutMillis: 1000, heartbeatIntervalMillis: 250, heartbeatTimeoutSecs: 2 },
    } })
    const connections: Connection[] = []
    try {
      await replica.start()
      const uri = replica.getUri(`work_replica_${randomUUID().replaceAll('-', '')}`)
      const connection = await storeCreateConnection(uri)
      connections.push(connection)
      const store = storeCreateGraphStore(connection)
      const service = graphCreateService(store, { leaseMs: 4000 })
      const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
      await service.dispatch({ requestId: randomUUID(), method: 'map.create', params: {
        workspaceId: DEVELOPMENT_WORKSPACE_ID, expectedRevision: 0, id: mapId, name: 'Replica election proof',
      } })
      await service.dispatch({ requestId: randomUUID(), method: 'graph.apply', params: {
        mapId, expectedRevision: 0,
        changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'Durable claim', category: 'data' } }] } },
      } })
      await service.dispatch({ requestId: randomUUID(), method: 'run.start', params: {
        mapId, expectedRevision: 1, id: runId, targetId: claimId, mode: 'auto', configuration: verificationConfiguration(),
      } })
      const router = await replicaReadGrant(service, mapId, 'router-host')
      expect(router.actor.role).toBe('router')
      const routeData = await service.readData(mapId, router.operationId, replicaReadProof(router))
      await service.propose({
        mapId, operationId: router.operationId, id: routeData.proposalId,
        kind: 'route', reason: 'Two independent evidence paths', slots: verificationSlots(2),
      }, replicaReadProof(router))

      const completed = await replicaReadGrant(service, mapId, 'completed-host')
      const acceptedReport = await replicaReadReport(service, completed)
      await service.propose(acceptedReport, replicaReadProof(completed))
      const unfinished = await replicaReadGrant(service, mapId, 'interrupted-host')
      const pendingReport = await replicaReadReport(service, unfinished)
      expect(unfinished.workId).not.toBe(completed.workId)
      const before = (await store.read(mapId))!
      expect(before.run!.operation.reports).toHaveLength(1)
      expect(before.receipts.some(receipt => receipt.requestId === acceptedReport.id)).toBe(true)
      expect(before.receipts.some(receipt => receipt.requestId === pendingReport.id)).toBe(false)
      expect(before.leases[unfinished.workId]).toEqual(unfinished)

      const oldPrimary = await replicaReadPrimary(connection)
      try {
        await connection.db!.admin().command({ replSetStepDown: 20, secondaryCatchUpPeriodSecs: 5 })
      } catch (error) {
        // A successful step-down can close the command socket before returning its acknowledgement.
        const electionError = error instanceof mongo.MongoNetworkError
          || (error instanceof mongo.MongoServerError && [91, 189, 10107, 11600, 11602].includes(Number(error.code)))
        if (!electionError) throw error
      }
      const newPrimary = await replicaReadPrimary(connection, oldPrimary)
      expect(newPrimary).not.toBe(oldPrimary)

      // A fresh client must discover the new primary and read the acknowledged state from it.
      const replacementConnection = await storeCreateConnection(uri)
      connections.push(replacementConnection)
      expect(await replicaReadPrimary(replacementConnection)).toBe(newPrimary)
      const replacementStore = storeCreateGraphStore(replacementConnection)
      const replacementService = graphCreateService(replacementStore, { leaseMs: 4000 })
      expect(await replacementStore.read(mapId)).toEqual(before)

      const hello = await replacementConnection.db!.admin().command({ hello: 1 })
      const remaining = Date.parse(unfinished.expiresAt) - new Date(hello.localTime).getTime()
      if (remaining > 0) await delay(remaining + 100)
      await expect(replacementService.dispatchWork({ method: 'renew', params: replicaReadProof(unfinished) }))
        .rejects.toMatchObject({ code: 'LEASE_LOST' })
      const replacement = await replicaReadGrant(replacementService, mapId, 'replacement-host')
      expect(replacement.workId).toBe(unfinished.workId)
      expect(replacement.fence).toBe(unfinished.fence + 1)
      expect(replacement.holderId).not.toBe(unfinished.holderId)
      await expect(replacementService.propose(pendingReport, replicaReadProof(unfinished)))
        .rejects.toMatchObject({ code: 'LEASE_LOST' })
      const fenced = (await replacementStore.read(mapId))!
      expect(fenced.run!.operation.reports).toEqual(before.run!.operation.reports)
      expect(fenced.receipts).toEqual(before.receipts)
      expect(fenced.leases[completed.workId]).toEqual(before.leases[completed.workId])
      expect(fenced.leases[unfinished.workId].fence).toBe(replacement.fence)

      await replacementService.propose(pendingReport, replicaReadProof(replacement))
      const finished = (await replacementStore.read(mapId))!
      expect(finished.run!.operation.reports).toHaveLength(2)
      expect(finished.receipts.filter(receipt => receipt.requestId === acceptedReport.id)).toHaveLength(1)
      expect(finished.receipts.filter(receipt => receipt.requestId === pendingReport.id)).toHaveLength(1)
    } finally {
      const closed = await Promise.allSettled(connections.map(storeDeleteConnection))
      await replica.stop({ doCleanup: true, force: true })
      const failure = closed.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }
  }, 60_000)
})
