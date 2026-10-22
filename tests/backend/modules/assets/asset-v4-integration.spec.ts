// 验证资产服务实际导出/导入 v4 闭包，并在新工作区重写声明式引用。
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_SEED } from '../../../../apps/config/default-prompts'
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { assetsCreateService, type AssetsService } from '../../../../backend/modules/assets/asset-service'
import { bundlesReadWorkspace } from '../../../../backend/modules/assets/bundle-codec'
import { authCreateService, type AuthService } from '../../../../backend/modules/identity/identity-service'
import { controlCreateService, type ControlService } from '../../../../backend/modules/workspace/workspace-service'
import { sourceReadUrl } from '../../../../backend/adapters/sources/http-source'
import { GRAPH_COLLECTION, type GraphDocument } from '../../../../backend/modules/graph/graph-record'
import type { Persistence } from '../../../../backend/ports/persistence'
import type { DefinitionPackage, ExecutionAgentDefinition } from '../../../../contracts/data-definition'
import { definitionsValidateCatalog } from '../../../../backend/modules/shared/data-definition'
import { graphParseNodes } from '../../../../backend/modules/shared/data-reference-index'
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
  auth = authCreateService(database); control = controlCreateService(database, DEFAULT_WORKSPACE_SEED)
  assets = assetsCreateService(database, auth, control, { readUrl: sourceReadUrl })
  await auth.initialize(); await control.initialize(); await database.graph().initialize(); await assets.initialize(); await control.seed()
  const user = await auth.createUser({ id: randomUUID(), displayName: 'Owner', hostAdmin: true })
  token = (await auth.createToken(user.userId)).token
}, 30_000)

afterAll(async () => {
  await connection?.close(); await mongo?.stop()
})

describe('Asset service v4 bundles', () => {
  it.each(['chongming-map', 'chongming-workspace'])('rejects v3 %s imports without creating workspace, graph, asset or receipt records', async (
    /* 以实际服务入口提交的旧版包格式。 */
    format,
  ) => {
    // 旧转换器能处理的包带有内嵌附件；版本拒绝必须发生在解包写入之前。
    const staging = await auth.transact(token, (
      /* 用于建立暂存工作区的所有者事务。 */
      ctx,
    ) => /* 从默认库建立定义齐全的工作区，避免用缺少定义掩盖版本拒绝。 */ control.createWorkspace(ctx, {
      id: randomUUID(), name: 'Legacy staging', description: '', agentSource: 'library',
    }))
    const content = Buffer.from('embedded legacy asset')
    const embeddedId = randomUUID()
    const now = '2026-09-28T00:00:00.000Z'
    const map = {
      id: randomUUID(), name: 'Legacy map', edges: [], nodes: [{
        id: randomUUID(), revision: 0, createdAt: now, updatedAt: now,
        data: { kind: 'source', locator: { kind: 'asset', assetId: embeddedId, mediaType: 'text/plain' }, label: 'Legacy source' },
      }],
    }
    const legacy = {
      format, version: 3, id: randomUUID(), exportedAt: now,
      ...(format === 'chongming-map'
        ? { map, agents: [] }
        : { maps: [map], workspace: { name: 'Legacy workspace', description: '', agents: [] } }),
      assets: [{ id: embeddedId, filename: 'legacy.txt', mediaType: 'text/plain', size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'), contentBase64: content.toString('base64') }],
    }
    const bytes = Buffer.from(JSON.stringify(legacy))
    const staged = (await assets.upload(token, {
      workspaceId: staging.id, filename: 'legacy.json', mediaType: 'application/json', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID(),
    }, Readable.from([bytes]))).data
    const collections = ['control_workspaces', GRAPH_COLLECTION, 'control_assets', 'asset_receipts', 'asset_blobs.files', 'asset_blobs.chunks']
    const before = await Promise.all(collections.map(
      /* 导入可能写入的 Mongo 元数据或 GridFS 集合。 */
      name => /* 在调用导入前记录各类对象数量。 */ connection.collection(name).countDocuments(),
    ))
    const targetId = randomUUID()
    const command = { requestId: randomUUID(), method: 'workspace.import' as const, params: {
      id: targetId, stagingWorkspaceId: staging.id, bundleAssetId: staged.id, name: null,
    } }
    await expect(assets.importWorkspace(token, command)).rejects.toMatchObject({
      code: 'BUNDLE_INVALID', message: 'Only v4 ChongMing bundles are supported',
    })
    await expect(assets.importWorkspace(token, command)).rejects.toMatchObject({ code: 'BUNDLE_INVALID' })
    const after = await Promise.all(collections.map(
      /* 导入可能写入的 Mongo 元数据或 GridFS 集合。 */
      name => /* 拒绝与重复拒绝后核对没有留下写入。 */ connection.collection(name).countDocuments(),
    ))
    expect(after).toEqual(before)
    expect(await database.records('control_workspaces').get(targetId)).toBeNull()
    expect(await assets.read(await auth.read(token), staged.id)).toMatchObject({ id: staged.id, workspaceId: staging.id })
  })

  it('requires staging ownership and replays a v4 import without creating duplicate objects', async () => {
    // 当前格式继续沿用导入权限与稳定请求身份；相同请求只创建一次工作区和图。
    const staging = await auth.transact(token, (
      /* 用于创建暂存工作区的所有者事务。 */
      ctx,
    ) => /* 建立不依赖默认定义的独立导入暂存区。 */ control.createWorkspace(ctx, {
      id: randomUUID(), name: 'V4 staging', description: '', agentSource: 'empty',
    }))
    const viewer = await auth.createUser({ id: randomUUID(), displayName: 'Import viewer', hostAdmin: false })
    const viewerToken = (await auth.createToken(viewer.userId)).token
    await auth.transact(token, (
      /* 修改暂存区成员权限的所有者事务。 */
      ctx,
    ) => /* Viewer 可读包资产，但没有创建导入的权限。 */ control.dispatch(ctx, {
      requestId: randomUUID(), method: 'member.set', params: {
        workspaceId: staging.id, expectedRevision: staging.revision, userId: viewer.userId, role: 'viewer',
      },
    }))
    const bundle = {
      format: 'chongming-map', version: 4, id: randomUUID(), exportedAt: '2026-09-28T00:00:00.000Z',
      map: { id: randomUUID(), name: 'Empty portable map', nodes: [], edges: [] }, agents: [], assets: [],
      definitions: { packages: [], agents: [], digests: [] },
    }
    const bytes = Buffer.from(JSON.stringify(bundle))
    const staged = (await assets.upload(token, {
      workspaceId: staging.id, filename: 'v4.json', mediaType: 'application/json', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID(),
    }, Readable.from([bytes]))).data
    const command = { requestId: randomUUID(), method: 'workspace.import' as const, params: {
      id: randomUUID(), stagingWorkspaceId: staging.id, bundleAssetId: staged.id, name: null,
    } }
    await expect(assets.importWorkspace(viewerToken, command)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const imported = await assets.importWorkspace(token, command)
    expect(imported.replayed).toBe(false)
    expect(imported.data.mapIds).toHaveLength(1)
    await expect(assets.importWorkspace(token, command)).resolves.toEqual({ data: imported.data, replayed: true })
    await expect(assets.importWorkspace(token, {
      ...command, params: { ...command.params, name: 'Conflicting name' },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(await database.records(GRAPH_COLLECTION).count({ workspaceId: imported.data.workspaceId })).toBe(1)
    expect(await database.records('asset_receipts').count({ workspaceId: imported.data.workspaceId })).toBe(1)
  })

  it('enforces media type on wildcard asset references at both independent and parsed internal entrances', async () => {
    // 直接入口和图提交已验引用入口都应使用每项真实父定位对象的媒体约束。
    const workspace = await auth.transact(token, (/* 本次建工作区的所有者写事务。 */ ctx) =>
      /* 建立本测试独占的资产归属。 */ control.createWorkspace(ctx, { id: randomUUID(), name: 'Wildcard media', description: '', agentSource: 'empty' }))
    const bytes = Buffer.from('wildcard text')
    const asset = (await assets.upload(token, { workspaceId: workspace.id, filename: 'wildcard.txt', mediaType: 'text/plain', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID() }, Readable.from([bytes]))).data
    const definition: DefinitionPackage = { id: 'fixture.media', version: 1, title: 'Media references', schemaDialect: 'http://json-schema.org/draft-07/schema#',
      dependencies: { packages: [], agents: [] }, transitions: [], dataTypes: [{ id: 'fixture.locators', version: 1, title: 'Locators',
        schema: { type: 'object', properties: { locators: { type: 'array', items: { type: 'object',
          properties: { assetId: { type: 'string' }, mediaType: { type: 'string' } }, required: ['assetId', 'mediaType'], additionalProperties: false,
        } } }, required: ['locators'], additionalProperties: false }, successorTypes: [],
        references: [{ path: '/locators/*/assetId', target: { kind: 'asset' } }], agentProjection: { include: ['/locators'], mapEntryFilters: [] },
      }] }
    await auth.transact(token, (/* 当前工作区的定义发布写事务。 */ ctx) => /* 发布本测试的真实不可变引用合同。 */ control.dispatch(ctx, {
      requestId: randomUUID(), method: 'definition.publish', params: { workspaceId: workspace.id, expectedRevision: workspace.revision, package: definition },
    }))
    const now = '2026-10-20T00:00:00.000Z'
    const node = { id: randomUUID(), revision: 0, typeId: 'fixture.locators', typeVersion: 1,
      payload: { locators: [{ assetId: asset.id, mediaType: 'application/pdf' }] }, createdAt: now, updatedAt: now }
    const ctx = await auth.read(token)
    const catalog = await control.definitions(ctx, workspace.id)
    await expect(assets.assertReferences(ctx, workspace.id, [node])).rejects.toMatchObject({ code: 'ASSET_REFERENCE' })
    await expect(assets.assertInternalReferences(workspace.id, graphParseNodes(catalog, [node]))).rejects.toMatchObject({ code: 'ASSET_REFERENCE' })
    node.payload.locators[0].mediaType = 'text/plain'
    await expect(assets.assertReferences(ctx, workspace.id, [node])).resolves.toBeUndefined()
    await expect(assets.assertInternalReferences(workspace.id, graphParseNodes(catalog, [node]))).resolves.toBeUndefined()
  })

  it('exports the exact definition closure and imports remapped assets/node references with no Run or lease', async () => {
    // 导出自包含定义闭包，验证篡改拒绝、历史配置保留与导入后的附件及 Claim 引用重映射。
    const workspace = await auth.transact(token, /* 已锁定所有者写权限的事务上下文。 */ ctx => /* 创建本次导出独占的来源工作区。 */ control.createWorkspace(ctx, {
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
        payload: { score: 0.5, reason: 'Opinion', evidenceClaimIds: [claimId] }, createdAt: now, updatedAt: now },
      { id: verificationId, revision: 4, typeId: 'factcheck.verification', typeVersion: 1,
        payload: { score: 0.5, reason: 'Conclusion', opinionIds: [opinionId] }, createdAt: now, updatedAt: now },
    ], edges: [
      { id: randomUUID(), revision: 0, kind: 'successor', from: claimId, to: opinionId, createdAt: now, updatedAt: now },
      { id: randomUUID(), revision: 0, kind: 'successor', from: opinionId, to: verificationId, createdAt: now, updatedAt: now },
    ], runs: [], runHistory: [], leases: {}, receipts: [{ requestId: 'private', method: 'graph.apply', inputHash: 'secret', createdNodeIds: [], createdEdgeIds: [], createdAt: now }],
    createdAt: now, updatedAt: now }
    await auth.transact(token, async (/* 已锁定所有者权限且承载本次图写入的事务。 */ ctx) => {
      // 在同一事务内验证附件引用并发布包含证据 Claim 引用的测试图。
      await assets.assertReferences(ctx, workspace.id, document.nodes)
      expect(await persistenceCreateMongo(connection).graph(ctx.session).create(document)).toBe(true)
    })
    const catalog = await control.definitions(await auth.read(token), workspace.id)
    const parsedNodes = graphParseNodes(catalog, [document.nodes[0]])
    await expect(assets.assertInternalReferences(workspace.id, parsedNodes)).resolves.toBeUndefined()
    await expect(assets.assertInternalReferences(randomUUID(), parsedNodes)).rejects.toMatchObject({ code: 'ASSET_REFERENCE' })

    const bundle = await assets.exportMap(await auth.read(token), document.id)
    expect(bundle).toMatchObject({ format: 'chongming-map', version: 4, definitions: { packages: [{ id: 'chongming.fact-checking', version: 1 }] } })
    expect(bundle.map).not.toHaveProperty('run'); expect(bundle.map).not.toHaveProperty('leases'); expect(bundle.map).not.toHaveProperty('receipts')
    expect(bundle.assets.map(/* 包内携带的不可变附件。 */ item => /* 返回导出附件身份以核对闭包完整性。 */ item.id)).toEqual([asset.id])
    const exactAgent = bundle.agents.find(
      /* 导出包携带的当前 Agent 配置。 */ agent => /* 找出同时具有精确执行快照的配置，供篡改和历史版本验证。 */ bundle.definitions.agents.some(
        /* 包内携带的一个精确 Agent 执行快照。 */ snapshot => /* 配置身份和版本必须与冻结快照完全相同。 */ snapshot.ref.id === agent.id && snapshot.ref.version === agent.revision,
      ),
    )
    assert.exists(exactAgent, 'Export must include an Agent matching an exact execution snapshot')
    const conflicting = structuredClone(bundle)
    const conflictingSnapshot = conflicting.definitions.agents.find(
      /* 将被篡改的包内精确执行快照。 */ snapshot => /* 定位原导出配置对应的精确身份，避免改动无关 Agent。 */ snapshot.ref.id === exactAgent.id && snapshot.ref.version === exactAgent.revision,
    )
    assert.exists(conflictingSnapshot, 'Copied bundle must retain the matching execution snapshot')
    conflictingSnapshot.profile.content += '\nhidden change'
    expect(() => /* 同版本配置内容与冻结快照不一致时，包解析必须拒绝。 */ bundlesReadWorkspace(conflicting)).toThrowError(/does not match its exact execution snapshot/i)
    const historical = structuredClone(bundle), advanced = historical.agents.find(
      /* 历史包中待推进当前版本的 Agent 配置。 */ agent => /* 保留旧执行快照，仅定位同身份的当前配置。 */ agent.id === exactAgent.id,
    )
    assert.exists(advanced, 'Copied bundle must retain the Agent configuration')
    advanced.revision += 1; advanced.content += '\nnew current version'
    expect(() => /* 当前配置升级后仍允许包保存已发布的历史执行快照。 */ bundlesReadWorkspace(historical)).not.toThrow()

    const bundleBytes = Buffer.from(JSON.stringify(bundle))
    const staged = (await assets.upload(token, { workspaceId: workspace.id, filename: 'bundle.json', mediaType: 'application/json', size: bundleBytes.length,
      sha256: createHash('sha256').update(bundleBytes).digest('hex'), requestId: randomUUID() }, Readable.from([bundleBytes]))).data
    const imported = await assets.importWorkspace(token, { requestId: randomUUID(), method: 'workspace.import', params: {
      id: randomUUID(), bundleAssetId: staged.id, stagingWorkspaceId: workspace.id, name: 'Imported',
    } })
    const map = await persistenceCreateMongo(connection).graph().read(imported.data.mapIds[0])
    assert.exists(map, 'Import must persist the exported graph')
    const importedOpinion = map.nodes.find(
      /* 导入后持久化的一个节点。 */ node => /* 找回核查意见以验证证据 Claim 身份重映射。 */ node.typeId === 'factcheck.opinion',
    )
    const importedClaim = map.nodes.find(
      /* 导入后持久化的一个节点。 */ node => /* 找回被核查意见引用的 Claim。 */ node.typeId === 'factcheck.claim',
    )
    const importedConclusion = map.nodes.find(
      /* 导入后持久化的一个节点。 */ node => /* 找回最终核查结论以验证 Opinion 身份重映射。 */ node.typeId === 'factcheck.verification',
    )
    const importedSource = map.nodes.find(
      /* 导入后持久化的一个节点。 */ node => /* 找回附件来源以验证 Asset 身份重映射。 */ node.typeId === 'factcheck.source',
    )
    assert.exists(importedOpinion, 'Import must retain the Opinion node')
    assert.exists(importedClaim, 'Import must retain the referenced Claim node')
    assert.exists(importedConclusion, 'Import must retain the Verification node')
    assert.exists(importedSource, 'Import must retain the Source node')
    expect(importedConclusion.payload.opinionIds).toEqual([importedOpinion.id])
    expect(importedOpinion.payload.evidenceClaimIds).toEqual([importedClaim.id])
    expect(importedSource.payload.locator).toMatchObject({ assetId: imported.data.assetIds[0] })
    expect(map).toMatchObject({ runs: [], runHistory: [], leases: {}, receipts: [] })
    expect((await control.definitions(await auth.read(token), imported.data.workspaceId)).dataTypes.map(
      /* 新工作区发布的一个精确类型定义。 */ type => /* 返回类型身份以确认导入包已安装可用定义。 */ type.id,
    )).toContain('factcheck.verification')
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

  it('rejects an existing node edit that introduces a missing asset without saving content or a receipt', async () => {
    // 资产检查共用本次正文解析结果时，已有节点的 put 也必须经过检查并整体回滚。
    const workspace = await auth.transact(token, (
      /* 为本次图修改建立独占工作区的所有者事务。 */ ctx,
    ) => /* 默认定义包含带资产引用声明的 Source 类型。 */ control.createWorkspace(ctx, {
      id: randomUUID(), name: 'Asset edit workspace', description: '', agentSource: 'library',
    }))
    const now = '2026-09-28T00:00:00.000Z'
    const nodeId = randomUUID()
    const document: GraphDocument = { id: randomUUID(), workspaceId: workspace.id, revision: 0, name: 'Asset edit', nodes: [
      { id: nodeId, revision: 0, typeId: 'factcheck.source', typeVersion: 1,
        payload: { label: 'Original', locator: { kind: 'url', url: 'https://example.com/source' } }, createdAt: now, updatedAt: now },
    ], edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    expect(await database.graph().create(document)).toBe(true)
    const application = applicationCreateService(connection)
    await application.initialize()
    await application.dispatch(token, { requestId: randomUUID(), method: 'branch.claim', params: {
      mapId: document.id, rootIds: [nodeId], holderId: randomUUID(),
    } })
    const claimed = await database.graph().read(document.id)
    assert.exists(claimed, 'Claimed graph must remain available')
    const editor = Object.values(claimed.branchOwnerships ?? {}).find(
      /* 本次通过真实公共命令取得的所有权。 */ ownership => /* 取得该节点编辑分支的实际租约证明。 */ ownership.kind === 'editor',
    )
    assert.exists(editor, 'Branch claim must establish an editor lease')
    const branch = branchReadSnapshot(claimed, [nodeId])
    await expect(application.dispatch(token, { requestId: randomUUID(), method: 'graph.apply', params: {
      mapId: document.id, branch: { rootIds: [nodeId], expectedVersion: branch.version },
      lease: { leaseId: editor.leaseId, holderId: editor.holderId, fence: editor.fence }, changes: { nodes: { put: [{
        id: nodeId, typeId: 'factcheck.source', typeVersion: 1,
        payload: { label: 'Invalid edit', locator: { kind: 'asset', assetId: randomUUID(), mediaType: 'text/plain' } },
      }] } },
    } })).rejects.toMatchObject({ code: 'ASSET_REFERENCE' })
    const stored = await database.graph().read(document.id)
    assert.exists(stored, 'Rejected edits must retain the graph')
    expect(stored.nodes).toEqual(claimed.nodes)
    expect(stored.revision).toBe(0)
    expect(stored.receipts).toEqual([])
  })
})
