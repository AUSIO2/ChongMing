// 验证 v4 便携包的精确定义闭包、通用引用重写及对旧版本的拒绝边界。
import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  bundlesCreateImport,
  bundlesReadWorkspace,
} from '../../../../backend/modules/assets/bundle-codec'
import { definitionsDigest } from '../../../../backend/modules/shared/data-definition'
import type { WorkspaceBundle } from '../../../../contracts/control'
import type { DefinitionPackage } from '../../../../contracts/data-definition'

function genericBundle(): WorkspaceBundle {
  const packageItem: DefinitionPackage = {
    id: 'portable.demo', version: 1, title: 'Portable demo', schemaDialect: 'http://json-schema.org/draft-07/schema#',
    dataTypes: [
      { id: 'portable.asset', version: 1, title: 'Asset', schema: { type: 'object', properties: {
        locator: { type: 'object', properties: { assetId: { type: 'string' }, mediaType: { type: 'string' } }, required: ['assetId', 'mediaType'], additionalProperties: false },
      }, required: ['locator'], additionalProperties: false }, successorTypes: [],
      references: [{ path: '/locator/assetId', target: { kind: 'asset' } }], agentProjection: { include: ['/locator'], mapEntryFilters: [] } },
      { id: 'portable.target', version: 1, title: 'Target', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        successorTypes: [], references: [], agentProjection: { include: ['/text'], mapEntryFilters: [] } },
      { id: 'portable.link', version: 1, title: 'Link', schema: { type: 'object', properties: { targetId: { type: 'string' } }, required: ['targetId'], additionalProperties: false },
        successorTypes: [], references: [{ path: '/targetId', target: { kind: 'node', types: [{ id: 'portable.target', version: 1 }] } }],
        agentProjection: { include: ['/targetId'], mapEntryFilters: [] } },
    ], transitions: [], dependencies: { packages: [], agents: [] },
  }
  const bytes = Buffer.from('portable asset'), assetId = randomUUID(), targetId = randomUUID(), linkId = randomUUID(), time = '2026-09-28T00:00:00.000Z'
  return { format: 'chongming-workspace', version: 4, id: randomUUID(), exportedAt: time,
    workspace: { name: 'Portable', description: '', agents: [] }, definitions: { packages: [packageItem], agents: [],
      digests: [{ ref: { id: packageItem.id, version: packageItem.version }, digest: definitionsDigest(packageItem) }] },
    maps: [{ id: randomUUID(), name: 'Map', nodes: [
      { id: randomUUID(), revision: 0, typeId: 'portable.asset', typeVersion: 1, payload: { locator: { assetId, mediaType: 'text/plain' } }, createdAt: time, updatedAt: time },
      { id: targetId, revision: 2, typeId: 'portable.target', typeVersion: 1, payload: { text: 'target' }, createdAt: time, updatedAt: time },
      { id: linkId, revision: 3, typeId: 'portable.link', typeVersion: 1, payload: { targetId }, createdAt: time, updatedAt: time },
    ], edges: [{ id: randomUUID(), revision: 0, kind: 'reference', from: linkId, to: targetId, createdAt: time, updatedAt: time }] }],
    assets: [{ id: assetId, filename: 'portable.txt', mediaType: 'text/plain', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') }] }
}

describe('Portable v4 bundle codec', () => {
  it('rejects a mismatching media type beside each concrete wildcard asset reference', () => {
    // 数组定位项的相邻媒体约束必须与该项资产对应，不能因声明路径含*而跳过。
    const bundle = genericBundle()
    const definition = bundle.definitions.packages[0]
    const type = definition.dataTypes[0]
    type.schema = { type: 'object', properties: { locators: { type: 'array', items: { type: 'object',
      properties: { assetId: { type: 'string' }, mediaType: { type: 'string' } }, required: ['assetId', 'mediaType'], additionalProperties: false,
    } } }, required: ['locators'], additionalProperties: false }
    type.references[0].path = '/locators/*/assetId'
    type.agentProjection.include = ['/locators']
    bundle.definitions.digests[0].digest = definitionsDigest(definition)
    bundle.maps[0].nodes[0].payload = { locators: [{ assetId: bundle.assets[0].id, mediaType: 'application/pdf' }] }
    expect(() => bundlesReadWorkspace(bundle)).toThrowError(/media type/i)
    bundle.maps[0].nodes[0].payload = { locators: [{ assetId: bundle.assets[0].id, mediaType: 'text/plain' }] }
    const parsed = bundlesReadWorkspace(bundle)
    const imported = bundlesCreateImport(parsed, randomUUID(), null)
    expect(imported.maps[0].nodes[0].payload.locators).toEqual([{ assetId: imported.assets[0].id, mediaType: 'text/plain' }])
  })

  it('preserves optional manual creation metadata while marking the resulting node as imported', () => {
    // 导入保留原创建记录，但明确附加导入来源，不冒充当前用户手工新建。
    const sourceBundle = genericBundle(), source = sourceBundle.maps[0].nodes[0]
    const manualOrigin = { userId: randomUUID() }
    Object.assign(source, { manualOrigin })
    const bundle = bundlesReadWorkspace(sourceBundle), imported = bundlesCreateImport(bundle, randomUUID(), null)
    const node = imported.maps[0].nodes.find((/* 重新分配身份的导入节点。 */ candidate) => /* 用原节点身份定位导入记录。 */ candidate.importedFrom?.nodeId === source.id)
    expect(node).toHaveProperty('manualOrigin', manualOrigin)
    expect(node).toHaveProperty('importedFrom', { bundleId: sourceBundle.id, nodeId: source.id, revision: source.revision })
  })

  it('retains current and historical source anchors while remapping edge endpoints on import', () => {
    const sourceBundle = genericBundle()
    const packageItem = sourceBundle.definitions.packages[0]
    const type = packageItem.dataTypes.find(type => type.id === 'portable.target')!
    type.successorTypes = [{ id: type.id, version: type.version }]
    sourceBundle.definitions.digests[0].digest = definitionsDigest(packageItem)
    const source = sourceBundle.maps[0].nodes.find(node => node.typeId === type.id)!
    source.payload.text = 'original first\r\noriginal second'
    const child = { ...structuredClone(source), id: randomUUID(), revision: 0, payload: { text: 'fact' } }
    sourceBundle.maps[0].nodes.push(child)
    const sourceAnchors = [
      { path: '/text', sourceRevision: source.revision, startLine: 1, endLine: 2, quote: 'original first\r\noriginal second' },
      { path: '/text', sourceRevision: source.revision - 1, startLine: 10, endLine: 10, quote: 'historical source excerpt' },
    ]
    sourceBundle.maps[0].edges.push({ id: randomUUID(), revision: 2, kind: 'successor', from: source.id,
      to: child.id, sourceAnchors, createdAt: source.createdAt, updatedAt: source.updatedAt })
    const bundle = bundlesReadWorkspace(sourceBundle), imported = bundlesCreateImport(bundle, randomUUID(), null)
    const importedEdge = imported.maps[0].edges.find(edge => edge.kind === 'successor')!
    expect(importedEdge.from).not.toBe(source.id)
    expect(imported.maps[0].nodes.find(node => node.id === importedEdge.from)?.revision).toBe(source.revision)
    expect(importedEdge.sourceAnchors).toEqual(sourceAnchors)
    const tampered = structuredClone(sourceBundle)
    tampered.maps[0].edges.find(edge => edge.kind === 'successor')!.sourceAnchors![0].quote = 'invented quote'
    expect(() => bundlesReadWorkspace(tampered)).toThrowError(/quote/i)
    const future = structuredClone(sourceBundle)
    future.maps[0].edges.find(edge => edge.kind === 'successor')!.sourceAnchors![0].sourceRevision = source.revision + 1
    expect(() => bundlesReadWorkspace(future)).toThrowError(/revision/i)
  })

  it('validates exact package digests and rewrites declared asset/node references without carrying execution state', () => {
    const bundle = bundlesReadWorkspace(genericBundle()), prepared = bundlesCreateImport(bundle, randomUUID(), null)
    const oldNodes = new Map(bundle.bundle.maps[0].nodes.map(node => [node.typeId, node])), newNodes = new Map(prepared.maps[0].nodes.map(node => [node.typeId, node]))
    const oldAsset = (oldNodes.get('portable.asset')!.payload.locator as { assetId: string }).assetId
    const newAsset = (newNodes.get('portable.asset')!.payload.locator as { assetId: string }).assetId
    expect(newAsset).not.toBe(oldAsset)
    expect(newAsset).toBe(prepared.assets[0].id)
    expect(newNodes.get('portable.link')!.payload.targetId).toBe(newNodes.get('portable.target')!.id)
    expect(prepared.maps[0]).toMatchObject({ runs: [], runHistory: [], leases: {}, receipts: [] })
    expect(JSON.stringify(bundle.bundle.maps[0])).not.toContain('runHistory')

    const changed = genericBundle()
    changed.definitions.packages[0].title = 'Tampered'
    expect(() => bundlesReadWorkspace(changed)).toThrowError(/digest/i)
    const extra = genericBundle()
    const unused = structuredClone(extra.definitions.packages[0]); unused.id = 'portable.unused'; unused.dataTypes = []; unused.transitions = []
    extra.definitions.packages.push(unused)
    extra.definitions.digests.push({ ref: { id: unused.id, version: unused.version }, digest: definitionsDigest(unused) })
    expect(() => bundlesReadWorkspace(extra)).toThrowError(/exact package closure/i)
    const dangling = genericBundle()
    dangling.maps[0].nodes.find(node => node.typeId === 'portable.link')!.payload.targetId = randomUUID()
    expect(() => bundlesReadWorkspace(dangling)).toThrowError(/reference is missing/i)
    const executable = genericBundle() as WorkspaceBundle & { maps: Array<WorkspaceBundle['maps'][number] & { runs?: unknown }> }
    executable.maps[0].runs = [{ status: 'running' }]
    expect(() => bundlesReadWorkspace(executable)).toThrowError(/map/i)

    const cyclic = genericBundle(), targetType = cyclic.definitions.packages[0].dataTypes.find(type => type.id === 'portable.target')!
    targetType.successorTypes = [{ id: targetType.id, version: targetType.version }]
    cyclic.definitions.digests[0].digest = definitionsDigest(cyclic.definitions.packages[0])
    const first = cyclic.maps[0].nodes.find(node => node.typeId === targetType.id)!, second = { ...structuredClone(first), id: randomUUID() }
    cyclic.maps[0].nodes.push(second)
    cyclic.maps[0].edges.push(
      { id: randomUUID(), revision: 0, kind: 'successor', from: first.id, to: second.id, createdAt: first.createdAt, updatedAt: first.updatedAt },
      { id: randomUUID(), revision: 0, kind: 'successor', from: second.id, to: first.id, createdAt: first.createdAt, updatedAt: first.updatedAt },
    )
    expect(() => bundlesReadWorkspace(cyclic)).toThrowError(/cycle/i)
  })

  it.each(['chongming-map', 'chongming-workspace'])('rejects v3 %s bundles before reading their content', (
    /* 要验证的旧版单图或工作区包格式。 */
    format,
  ) => {
    // 旧包没有 v4 定义闭包，应直接按版本拒绝，不再进入旧类型转换。
    const legacy = { format, version: 3, id: randomUUID(), exportedAt: '2026-09-28T00:00:00.000Z', assets: [] }
    expect(() => /* 检查公开解析入口按版本返回统一错误。 */ bundlesReadWorkspace(legacy)).toThrowError(/Only v4/i)
  })
})
