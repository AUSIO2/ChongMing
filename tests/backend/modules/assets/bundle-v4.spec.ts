// 验证 v4 便携包的精确定义闭包、通用引用重写和独立 v3 转换边界。
import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DEFINITION_PACKAGE, DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'
import {
  bundlesConvertV3,
  bundlesCreateImport,
  bundlesReadWorkspace,
} from '../../../../backend/modules/assets/bundle-codec'
import { definitionsDigest, definitionsValidateCatalog } from '../../../../backend/modules/shared/data-definition'
import type { WorkspaceBundle } from '../../../../contracts/control'
import type { DefinitionPackage, ExecutionAgentDefinition } from '../../../../contracts/data-definition'

function agents(): ExecutionAgentDefinition[] {
  const config = DEFAULT_RUN_CONFIGURATION
  const profiles = [config.parse, config.split.router, ...config.split.agents, config.split.merger, config.router, ...config.agents, config.merger]
  return profiles.map(profile => ({ ref: { id: profile.id, version: 0 }, profile }))
}

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
  it('validates exact package digests and rewrites declared asset/node references without carrying execution state', () => {
    const bundle = bundlesReadWorkspace(genericBundle()), prepared = bundlesCreateImport(bundle, randomUUID(), null)
    const oldNodes = new Map(bundle.maps[0].nodes.map(node => [node.typeId, node])), newNodes = new Map(prepared.maps[0].nodes.map(node => [node.typeId, node]))
    const oldAsset = (oldNodes.get('portable.asset')!.payload.locator as { assetId: string }).assetId
    const newAsset = (newNodes.get('portable.asset')!.payload.locator as { assetId: string }).assetId
    expect(newAsset).not.toBe(oldAsset)
    expect(newAsset).toBe(prepared.assets[0].id)
    expect(newNodes.get('portable.link')!.payload.targetId).toBe(newNodes.get('portable.target')!.id)
    expect(prepared.maps[0]).toMatchObject({ runs: [], runHistory: [], leases: {}, receipts: [] })
    expect(JSON.stringify(bundle.maps[0])).not.toContain('runHistory')

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

  it('keeps v3 outside the v4 parser and explicitly promotes embedded reports to one referenced opinion node', () => {
    const time = '2026-09-28T00:00:00.000Z', claimId = randomUUID(), verificationId = randomUUID(), reportId = 'legacy-report'
    const legacy = { format: 'chongming-map', version: 3, id: randomUUID(), exportedAt: time, agents: [], assets: [], map: {
      id: randomUUID(), name: 'Legacy', nodes: [
        { id: claimId, revision: 1, data: { kind: 'claim', content: 'Claim', category: null }, createdAt: time, updatedAt: time },
        { id: verificationId, revision: 2, data: { kind: 'verification', score: 0.5, reason: 'Conclusion', reportIds: [reportId, reportId], opinions: [
          { id: reportId, slotId: 'slot', agentId: 'retired', agentName: 'Retired', angle: '', tools: ['archive', 'archive'], routeRevision: 1, score: 0.5, reason: 'Opinion', createdAt: time },
          { id: reportId, slotId: 'slot', agentId: 'retired', agentName: 'Retired', angle: '', tools: ['archive', 'archive'], routeRevision: 1, score: 0.5, reason: 'Opinion', createdAt: time },
        ] }, createdAt: time, updatedAt: time },
      ], edges: [{ id: randomUUID(), revision: 0, kind: 'verifies', from: verificationId, to: claimId, createdAt: time, updatedAt: time }],
    } }
    expect(() => bundlesReadWorkspace(legacy)).toThrowError(/v4/i)
    const catalog = definitionsValidateCatalog([DEFAULT_DEFINITION_PACKAGE], agents())
    const converted = bundlesConvertV3(legacy, catalog)
    const opinions = converted.maps[0].nodes.filter(node => node.typeId === 'factcheck.opinion')
    expect(opinions).toHaveLength(1)
    expect(opinions[0].payload).toMatchObject({ legacy: { reportId, tools: ['archive', 'archive'] } })
    expect(converted.maps[0].nodes.find(node => node.id === verificationId)?.payload).toMatchObject({ opinionIds: [opinions[0].id] })
    expect(converted.maps[0].edges.some(edge => edge.kind === 'successor' && edge.from === claimId && edge.to === opinions[0].id)).toBe(true)
  })
})
