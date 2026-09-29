// 验证资产服务实际导出/导入 v4 闭包，并在新工作区重写声明式引用。
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { assetsCreateService, type AssetsService } from '../../../../backend/modules/assets/asset-service'
import { bundlesReadWorkspace } from '../../../../backend/modules/assets/bundle-codec'
import { authCreateService, type AuthService } from '../../../../backend/modules/identity/identity-service'
import { controlCreateService, type ControlService } from '../../../../backend/modules/workspace/workspace-service'
import { sourceReadUrl } from '../../../../backend/adapters/sources/http-source'
import type { GraphDocument } from '../../../../backend/modules/graph/graph-record'
import type { Persistence } from '../../../../backend/ports/persistence'
import type { DefinitionPackage, ExecutionAgentDefinition } from '../../../../contracts/data-definition'
import { definitionsValidateCatalog } from '../../../../backend/modules/shared/data-definition'
import { runCreateRun, runUpdateProposal } from '../../../../backend/modules/graph/run-state'
import { branchReadSnapshot } from '../../../../backend/modules/graph/branch-state'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import { applicationCreateService } from '../../../../apps/graph-server/application'

let mongo: MongoMemoryReplSet, connection: Connection, auth: AuthService, control: ControlService, assets: AssetsService
let database: Persistence
let token: string

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
  connection = await storeCreateConnection(mongo.getUri('asset_v4_' + randomUUID()))
  database = persistenceCreateMongo(connection)
  auth = authCreateService(database); control = controlCreateService(database, DEFAULT_RUN_CONFIGURATION)
  assets = assetsCreateService(database, auth, control, { readUrl: sourceReadUrl })
  await auth.initialize(); await control.initialize(); await database.graph().initialize(); await assets.initialize(); await control.seed()
  const user = await auth.createUser({ id: randomUUID(), displayName: 'Owner', hostAdmin: true })
  token = (await auth.createToken(user.userId)).token
}, 30_000)

afterAll(async () => {
  await connection?.close(); await mongo?.stop()
})

describe('Asset service v4 bundles', () => {
  it('exports the exact definition closure and imports remapped assets/node references with no Run or lease', async () => {
    const workspace = await auth.transact(token, ctx => control.createWorkspace(ctx, {
      id: randomUUID(), name: 'Source workspace', description: '', agentSource: 'library',
    }))
    const bytes = Buffer.from('source text'), sha256 = createHash('sha256').update(bytes).digest('hex')
    const asset = (await assets.upload(token, { workspaceId: workspace.id, filename: 'source.txt', mediaType: 'text/plain', size: bytes.length,
      sha256, requestId: randomUUID() }, Readable.from([bytes]))).data
    const now = '2026-09-28T00:00:00.000Z', sourceId = randomUUID(), claimId = randomUUID(), opinionId = randomUUID(), verificationId = randomUUID()
    const document: GraphDocument = { id: randomUUID(), workspaceId: workspace.id, revision: 5, name: 'Portable', nodes: [
      { id: sourceId, revision: 1, typeId: 'factcheck.source', typeVersion: 1,
        payload: { locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: 'source' }, createdAt: now, updatedAt: now },
      { id: claimId, revision: 2, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'Claim', category: null }, createdAt: now, updatedAt: now },
      { id: opinionId, revision: 3, typeId: 'factcheck.opinion', typeVersion: 1,
        payload: { score: 0.5, reason: 'Opinion', evidenceIds: [] }, createdAt: now, updatedAt: now },
      { id: verificationId, revision: 4, typeId: 'factcheck.verification', typeVersion: 1,
        payload: { score: 0.5, reason: 'Conclusion', opinionIds: [opinionId] }, createdAt: now, updatedAt: now },
    ], edges: [
      { id: randomUUID(), revision: 0, kind: 'successor', from: claimId, to: opinionId, createdAt: now, updatedAt: now },
      { id: randomUUID(), revision: 0, kind: 'successor', from: opinionId, to: verificationId, createdAt: now, updatedAt: now },
    ], runs: [], runHistory: [], leases: {}, receipts: [{ requestId: 'private', method: 'graph.apply', inputHash: 'secret', createdNodeIds: [], createdEdgeIds: [], createdAt: now }],
    createdAt: now, updatedAt: now }
    await auth.transact(token, async ctx => {
      await assets.assertReferences(ctx, workspace.id, document.nodes)
      expect(await persistenceCreateMongo(connection).graph(ctx.session).create(document)).toBe(true)
    })
    const catalog = await control.definitions(await auth.read(token), workspace.id)
    await expect(assets.assertInternalReferences(workspace.id, [document.nodes[0]], catalog)).resolves.toBeUndefined()
    await expect(assets.assertInternalReferences(randomUUID(), [document.nodes[0]], catalog)).rejects.toMatchObject({ code: 'ASSET_REFERENCE' })

    const bundle = await assets.exportMap(await auth.read(token), document.id)
    expect(bundle).toMatchObject({ format: 'chongming-map', version: 4, definitions: { packages: [{ id: 'chongming.fact-checking', version: 1 }] } })
    expect(bundle.map).not.toHaveProperty('run'); expect(bundle.map).not.toHaveProperty('leases'); expect(bundle.map).not.toHaveProperty('receipts')
    expect(bundle.assets.map(item => item.id)).toEqual([asset.id])
    const exactAgent = bundle.agents.find(agent => bundle.definitions.agents.some(snapshot => snapshot.ref.id === agent.id && snapshot.ref.version === agent.revision))!
    const conflicting = structuredClone(bundle)
    conflicting.definitions.agents.find(snapshot => snapshot.ref.id === exactAgent.id && snapshot.ref.version === exactAgent.revision)!.profile.content += '\nhidden change'
    expect(() => bundlesReadWorkspace(conflicting)).toThrowError(/does not match its exact execution snapshot/i)
    const historical = structuredClone(bundle), advanced = historical.agents.find(agent => agent.id === exactAgent.id)!
    advanced.revision += 1; advanced.content += '\nnew current version'
    expect(() => bundlesReadWorkspace(historical)).not.toThrow()

    const bundleBytes = Buffer.from(JSON.stringify(bundle))
    const staged = (await assets.upload(token, { workspaceId: workspace.id, filename: 'bundle.json', mediaType: 'application/json', size: bundleBytes.length,
      sha256: createHash('sha256').update(bundleBytes).digest('hex'), requestId: randomUUID() }, Readable.from([bundleBytes]))).data
    const imported = await assets.importWorkspace(token, { requestId: randomUUID(), method: 'workspace.import', params: {
      id: randomUUID(), bundleAssetId: staged.id, stagingWorkspaceId: workspace.id, name: 'Imported',
    } })
    const map = await persistenceCreateMongo(connection).graph().read(imported.data.mapIds[0])
    const importedOpinion = map!.nodes.find(node => node.typeId === 'factcheck.opinion')!
    const importedConclusion = map!.nodes.find(node => node.typeId === 'factcheck.verification')!
    const importedSource = map!.nodes.find(node => node.typeId === 'factcheck.source')!
    expect(importedConclusion.payload.opinionIds).toEqual([importedOpinion.id])
    expect((importedSource.payload.locator as { assetId: string }).assetId).toBe(imported.data.assetIds[0])
    expect(map).toMatchObject({ runs: [], runHistory: [], leases: {}, receipts: [] })
    expect((await control.definitions(await auth.read(token), imported.data.workspaceId)).dataTypes.map(type => type.id)).toContain('factcheck.verification')
  })

  it('revalidates candidate asset references when human review publishes the result', async () => {
    const workspace = await auth.transact(token, ctx => control.createWorkspace(ctx, {
      id: randomUUID(), name: 'Review workspace', description: '', agentSource: 'empty',
    }))
    const bytes = Buffer.from('temporary candidate asset'), sha256 = createHash('sha256').update(bytes).digest('hex')
    const asset = (await assets.upload(token, { workspaceId: workspace.id, filename: 'candidate.txt', mediaType: 'text/plain', size: bytes.length,
      sha256, requestId: randomUUID() }, Readable.from([bytes]))).data
    const inputType = { id: 'asset-review.input', version: 1 }, outputType = { id: 'asset-review.output', version: 1 }
    const transitionRef = { id: 'asset-review.create', version: 1 }, agentRef = { id: 'asset-review.agent', version: 1 }
    const agent: ExecutionAgentDefinition = { ref: agentRef, profile: { id: agentRef.id, name: 'Asset producer', description: '', content: 'produce',
      tools: [], provider: 'fixture', model: 'fixture', promptVars: [] } }
    const packageItem: DefinitionPackage = { id: 'asset-review', version: 1, title: 'Asset review', schemaDialect: 'http://json-schema.org/draft-07/schema#',
      dependencies: { packages: [], agents: [agentRef] }, dataTypes: [
        { ...inputType, title: 'Input', schema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
          successorTypes: [outputType], references: [], agentProjection: { include: ['/text'], mapEntryFilters: [] } },
        { ...outputType, title: 'Output', schema: { type: 'object', properties: { locator: { type: 'object', properties: {
          kind: { const: 'asset' }, assetId: { type: 'string', minLength: 1 }, mediaType: { type: 'string', minLength: 1 },
        }, required: ['kind', 'assetId', 'mediaType'], additionalProperties: false } }, required: ['locator'], additionalProperties: false },
          successorTypes: [], references: [{ path: '/locator/assetId', target: { kind: 'asset' } }], agentProjection: { include: ['/locator'], mapEntryFilters: [] } },
      ], transitions: [{ ...transitionRef, title: 'Create asset output', cardinality: '1:1', group: { mode: 'explicit-members', ready: 'sealed-all-required' },
        ports: { input: [{ name: 'input', inputType, count: { min: 1, max: 1 } }], context: [],
          output: [{ name: 'output', outputType, count: { min: 1, max: 1 }, successorOf: [{ source: 'input', port: 'input' }] }] },
        execution: { stages: [{ id: 'produce', kind: 'agent', agentRef, dependsOn: [], ready: 'all-dependencies', resultMode: 'outputs',
          outputPorts: [{ port: 'output', count: { min: 1, max: 1 } }], promptBindings: {} }], resultStage: 'produce' },
        review: { mode: 'required', at: 'result', onReject: 'fail' } }],
    }
    const catalog = definitionsValidateCatalog([packageItem], [agent]), now = '2026-09-28T00:00:00.000Z'
    await database.records<any>('control_workspaces').change(workspace.id, current => ({ ...current,
      definitionPackages: [packageItem], definitionAgents: [agent] }))
    const inputId = randomUUID(), document: GraphDocument = { id: randomUUID(), workspaceId: workspace.id, revision: 0, name: 'Review', nodes: [
      { id: inputId, revision: 0, typeId: inputType.id, typeVersion: inputType.version, payload: { text: 'input' }, createdAt: now, updatedAt: now },
    ], edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    const runBranch = branchReadSnapshot(document, [inputId])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version }, scope: { nodeIds: [inputId] }, mode: 'human-in-loop', plan: { steps: [{
      id: 'create', transitionRef, dependsOn: [], input: [{ port: 'input', source: { kind: 'scope', nodeIds: [inputId] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 1 }, now)
    document.ownershipRevision = 1
    const controlId = randomUUID(), controlHolderId = randomUUID()
    const run = document.runs[0]
    document.branchOwnerships = { [run.id]: { leaseId: run.id, kind: 'run', rootIds: runBranch.scope.rootIds,
      ownerUserId: workspace.members[0].userId, holderId: randomUUID(), fence: 1, expiresAt: null, leaseMs: null, runId: run.id },
      [controlId]: { leaseId: controlId, kind: 'control', runId: run.id, ownerUserId: workspace.members[0].userId,
        holderId: controlHolderId, fence: 2, expiresAt: '2999-01-01T00:00:00.000Z', leaseMs: 30_000 } }
    document.ownershipReceipts = []
    const work = workReadItems(document)[0]
    const proposal = runUpdateProposal(document, { mapId: document.id, operationId: work.operationId, id: work.workId, specHash: work.specHash,
      kind: 'outputs', reason: 'candidate', outputs: [{ key: 'asset-output', port: 'output', typeRef: outputType,
        payload: { locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType } } }] }, work, '2026-09-28T00:00:01.000Z')
    expect(proposal.nodeIds).toEqual([]); expect(run.status).toBe('waiting')
    expect(await database.graph().create(document)).toBe(true)
    await auth.transact(token, ctx => assets.delete(ctx, { requestId: randomUUID(), method: 'asset.delete',
      params: { assetId: asset.id, expectedSha256: asset.sha256 } }))
    const operation = run.operations[0], review = operation.review!
    const application = applicationCreateService(connection)
    await application.initialize()
    await expect(application.dispatch(token, { requestId: randomUUID(), method: 'review.answer', params: { mapId: document.id, runId: run.id,
      operationId: operation.id, reviewId: review.id, expectedReviewRevision: review.revision, decision: 'approve',
      control: { leaseId: controlId, holderId: controlHolderId, fence: 2 } } }))
      .rejects.toMatchObject({ code: 'ASSET_REFERENCE' })
    const stored = await database.graph().read(document.id)
    expect(stored!.nodes).toHaveLength(1); expect(stored!.runs[0]?.operations[0].review).toMatchObject({ state: 'pending', decision: null })

    const raceBytes = Buffer.from('racing candidate asset'), raceSha = createHash('sha256').update(raceBytes).digest('hex')
    const raceAsset = (await assets.upload(token, { workspaceId: workspace.id, filename: 'race.txt', mediaType: 'text/plain', size: raceBytes.length,
      sha256: raceSha, requestId: randomUUID() }, Readable.from([raceBytes]))).data
    const racing = structuredClone(document); racing.id = randomUUID(); racing.revision = 0; racing.receipts = []
    const candidate = racing.runs[0].operations[0].stages.flatMap(stage => stage.results).find(result => result.mode === 'outputs')!
    if (candidate.mode !== 'outputs') throw new Error('expected output candidate')
    candidate.outputs[0].payload = { locator: { kind: 'asset', assetId: raceAsset.id, mediaType: raceAsset.mediaType } }
    expect(await database.graph().create(racing)).toBe(true)
    const raceOperation = racing.runs[0].operations[0], raceReview = raceOperation.review!
    const results = await Promise.allSettled([
      application.dispatch(token, { requestId: randomUUID(), method: 'review.answer', params: { mapId: racing.id, runId: racing.runs[0].id,
        operationId: raceOperation.id, reviewId: raceReview.id, expectedReviewRevision: raceReview.revision, decision: 'approve',
        control: { leaseId: controlId, holderId: controlHolderId, fence: 2 } } }),
      application.dispatch(token, { requestId: randomUUID(), method: 'asset.delete', params: { assetId: raceAsset.id, expectedSha256: raceAsset.sha256 } }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const raceMap = await database.graph().read(racing.id), published = raceMap!.nodes.length === 2
    if (published) await expect(assets.read(await auth.read(token), raceAsset.id)).resolves.toMatchObject({ id: raceAsset.id })
    else await expect(assets.read(await auth.read(token), raceAsset.id)).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' })
  })
})
