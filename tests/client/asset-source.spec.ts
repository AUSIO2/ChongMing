// C20 资产快捷来源只构造所选位置，Schema与引用权限仍由后端权威校验。
import { describe, expect, it } from 'vitest'

import type { Asset } from '../../contracts/control'
import type { DataSchema, DataTypeDefinition, DefinitionCatalog, DefinitionPackage } from '../../contracts/data-definition'
import type { GraphPayload } from '../../contracts/graph'
import { definitionsParsePayload, definitionsValidateCatalog } from '../../backend/modules/shared/data-definition'
import { assetBuildSourceDraft, assetCreateSourcePayload, assetReadSourceChoices, assetReadSourceReferences, assetReadSourceTargets } from '../../apps/ui/features/assets/asset-source'

const file: Asset = { id: 'asset-one', workspaceId: 'workspace-one', filename: '原始材料.txt', mediaType: 'text/plain',
  size: 12, sha256: 'a'.repeat(64), createdAt: '2026-10-21T00:00:00.000Z' }
const locator: DataSchema = { type: 'object', properties: { kind: { const: 'asset' }, assetId: { type: 'string' },
  mediaType: { type: 'string' } }, required: ['kind', 'assetId', 'mediaType'], additionalProperties: false }
const documentType: DataTypeDefinition = { id: 'test.document', version: 1, title: '双位置文档',
  schema: { type: 'object', properties: { primary: locator, secondary: locator, note: { type: 'string', minLength: 1 },
    title: { type: 'string' } }, required: ['note'], additionalProperties: false },
  successorTypes: [], agentProjection: { include: ['/primary', '/secondary', '/note'], mapEntryFilters: [] },
  presentation: { titlePath: '/title' }, references: [
    { path: '/primary/assetId', target: { kind: 'asset' }, when: { path: '/primary/kind', equals: 'asset' } },
    { path: '/secondary/assetId', target: { kind: 'asset' }, when: { path: '/secondary/kind', equals: 'asset' } },
  ] }

function catalog(
  /* 同一目录中已发布的精确类型。 */ dataTypes: DataTypeDefinition[],
): DefinitionCatalog {
  // 选择项只需要当前真实目录，不在前端重新发布或编译定义。
  return { revision: 3, packages: [], index: [], transitions: [], dataTypes }
}

describe('C20 explicit Asset source construction', () => {
  // 通过观察保存正文和实际引用判断结果，不对私有遍历步骤写镜像断言。
  it('explicitly rejects a nonobject initial value and keeps a later valid selection independent', () => {
    // 发布目录可有array根类型，但图节点快捷来源必须遵守对象正文合同。
    const arrayType = structuredClone(documentType)
    arrayType.id = 'test.array-source'
    arrayType.schema = { type: 'array', items: locator }
    arrayType.references = [{ path: '/*/assetId', target: { kind: 'asset' } }]
    expect(() => /* 非对象初值应明确拒绝，而不是伪造空对象继续提交。 */ assetCreateSourcePayload(arrayType)).toThrow(/对象正文/)
    const recovered = assetCreateSourcePayload(documentType)
    expect(recovered).toEqual({ note: '' })
    recovered.note = '切回有效类型后的独立正文'
    expect(assetCreateSourcePayload(documentType)).toEqual({ note: '' })
  })

  it('lists every exact asset type and declared position without choosing the first type', () => {
    // 同ID不同版本和同类型不同位置保持可区分，不把普通数据类型列为来源。
    const newer = { ...structuredClone(documentType), version: 2 }
    const plain = { ...structuredClone(documentType), id: 'test.plain', references: [] }
    expect(assetReadSourceChoices(catalog([plain, newer, documentType]))).toEqual([
      { typeRef: { id: documentType.id, version: 2 }, referenceIndex: 0, path: '/primary/assetId' },
      { typeRef: { id: documentType.id, version: 2 }, referenceIndex: 1, path: '/secondary/assetId' },
      { typeRef: { id: documentType.id, version: 1 }, referenceIndex: 0, path: '/primary/assetId' },
      { typeRef: { id: documentType.id, version: 1 }, referenceIndex: 1, path: '/secondary/assetId' },
    ])
    expect(assetReadSourceChoices(null)).toEqual([])
  })

  it('creates only the selected optional object and preserves extra fields with a backend-valid reference', () => {
    // 选secondary不会顺带建立primary，也不会丢失用户填写的必填说明。
    const payload = assetCreateSourcePayload(documentType)
    payload.note = '用户明确填写的额外说明'
    const before = structuredClone(payload)
    const targets = assetReadSourceTargets(documentType, payload)
    expect(targets.map((/* 所有可明确选择的位置。 */ target) => /* 展示具体JSON Pointer。 */ target.path))
      .toEqual(['/primary/assetId', '/secondary/assetId'])
    const result = assetBuildSourceDraft({ workspaceId: file.workspaceId, asset: file, type: documentType, payload, target: targets[1] })
    expect(result).toEqual({ ok: true, payload: { note: before.note, title: file.filename,
      secondary: { kind: 'asset', assetId: file.id, mediaType: file.mediaType } } })
    expect(payload).toEqual(before)
    if (!result.ok) return
    const packageItem: DefinitionPackage = { id: 'test.assets', version: 1, title: '资产类型',
      schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes: [documentType], transitions: [], dependencies: { packages: [], agents: [] } }
    const definitions = definitionsValidateCatalog([packageItem])
    expect(definitionsParsePayload(definitions, documentType, result.payload).references.map(
      /* 原后端解析出的实际引用。 */ reference => /* 快捷构造没有靠本地自证代替权威Schema。 */ ({ path: reference.path, value: reference.value }),
    )).toEqual([{ path: '/secondary/assetId', value: file.id }])
  })

  it('keeps an edited title and does not invent undeclared metadata beside a bare asset field', () => {
    // 无mediaType声明的字段只写资产身份，已有标题不被文件名覆盖。
    const type = structuredClone(documentType)
    type.schema.properties = { attachment: { type: 'string' }, note: { type: 'string' }, title: { type: 'string' } }
    type.references = [{ path: '/attachment', target: { kind: 'asset' } }]
    const payload = { note: '保留说明', title: '用户另起的标题' }
    expect(assetBuildSourceDraft({ workspaceId: file.workspaceId, asset: file, type, payload,
      target: assetReadSourceTargets(type, payload)[0] })).toEqual({ ok: true, payload: { ...payload, attachment: file.id } })
  })

  it('requires existing wildcard positions and writes the chosen array item without changing its sibling', () => {
    // 空数组不能假装第0项存在；oneOf的URL分支也不成为资产位置。
    const type = structuredClone(documentType)
    type.schema = { type: 'object', properties: { locators: { type: 'array', items: { oneOf: [
      { type: 'object', properties: { kind: { const: 'url' }, url: { type: 'string' } }, required: ['kind', 'url'], additionalProperties: false }, locator,
    ] } }, note: { type: 'string' } }, required: ['locators', 'note'], additionalProperties: false }
    type.references = [{ path: '/locators/*/assetId', target: { kind: 'asset' }, when: { path: '/locators/*/kind', equals: 'asset' } }]
    delete type.presentation
    const initial = assetCreateSourcePayload(type)
    expect(assetReadSourceTargets(type, initial)).toEqual([])
    const urlLocator: GraphPayload = { kind: 'url', url: 'https://example.test/source' }
    const assetLocator: GraphPayload = { kind: 'asset', assetId: '', mediaType: '' }
    const payload = { locators: [urlLocator, assetLocator], note: '第二项是本次明确位置' }
    const targets = assetReadSourceTargets(type, payload)
    expect(targets).toEqual([{ typeRef: { id: type.id, version: type.version }, referenceIndex: 0, path: '/locators/1/assetId' }])
    expect(assetBuildSourceDraft({ workspaceId: file.workspaceId, asset: file, type, payload, target: targets[0] }))
      .toEqual({ ok: true, payload: { ...payload, locators: [payload.locators[0], { kind: 'asset', assetId: file.id, mediaType: file.mediaType }] } })
    expect(payload.locators[1].assetId).toBe('')
    expect(JSON.stringify(payload)).not.toContain('"*"')
  })

  it('supports declared scalar array items and escaped dictionary keys without creating wildcard properties', () => {
    // 展开真实数组/字典成员后使用具体位置，不能把*写进对象或猜测数组下标。
    const type = structuredClone(documentType)
    type.schema = { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } },
      files: { type: 'object', additionalProperties: locator } }, required: ['ids', 'files'], additionalProperties: false }
    type.references = [{ path: '/ids/*', target: { kind: 'asset' } }, { path: '/files/*/assetId', target: { kind: 'asset' } }]
    delete type.presentation
    const payload = { ids: ['old-file', ''], files: { 'name/~one': { kind: 'asset', assetId: '', mediaType: '' } } }
    const targets = assetReadSourceTargets(type, payload)
    expect(targets.map((/* 真实成员对应的具体引用位置。 */ target) => /* 编码后的Pointer不能改变字段身份。 */ target.path))
      .toEqual(['/ids/0', '/ids/1', '/files/name~1~0one/assetId'])
    expect(assetBuildSourceDraft({ workspaceId: file.workspaceId, asset: file, type, payload, target: targets[1] }))
      .toMatchObject({ ok: true, payload: { ids: ['old-file', file.id], files: payload.files } })
  })

  it('evaluates when at the root with ANY semantics and preserves typed structural equality', () => {
    // 条件是整个声明的根路径ANY，不是与数组目标按索引配对，也不把0/false变字符串。
    const type = structuredClone(documentType)
    type.schema = { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } },
      flags: { type: 'array', items: { type: 'object' } } }, required: ['ids', 'flags'], additionalProperties: false }
    type.references = [{ path: '/ids/*', target: { kind: 'asset' }, when: { path: '/flags/*', equals: { enabled: false, level: 0 } } }]
    const payload = { ids: ['other-file', file.id], flags: [{ level: 0, enabled: false }] }
    expect(assetReadSourceReferences(type, payload)).toEqual([{ path: '/ids/0', assetId: 'other-file' }, { path: '/ids/1', assetId: file.id }])
    expect(assetReadSourceReferences(type, { ...payload, flags: [{ level: 0, enabled: 'false' }] })).toEqual([])
    const inactive = { ...payload, flags: [] }
    expect(assetBuildSourceDraft({ workspaceId: file.workspaceId, asset: file, type, payload: inactive,
      target: assetReadSourceTargets(type, inactive)[0] })).toMatchObject({ ok: false })
    expect(inactive).toEqual({ ids: ['other-file', file.id], flags: [] })
  })

  it('rejects a mismatched asset workspace, exact type, declaration or nonexistent concrete target', () => {
    // 选中的资产与位置属于固定目标，不接受从旧类型草稿带来的另一条路径。
    const payload = { note: '保留原草稿' }
    const target = assetReadSourceTargets(documentType, payload)[1]
    const base = { workspaceId: file.workspaceId, asset: file, type: documentType, payload, target }
    expect(assetBuildSourceDraft({ ...base, workspaceId: 'other-workspace' })).toMatchObject({ ok: false })
    expect(assetBuildSourceDraft({ ...base, target: { ...target, typeRef: { ...target.typeRef, version: 2 } } })).toMatchObject({ ok: false })
    expect(assetBuildSourceDraft({ ...base, target: { ...target, referenceIndex: 20 } })).toMatchObject({ ok: false })
    expect(assetBuildSourceDraft({ ...base, target: { ...target, path: '/missing/assetId' } })).toMatchObject({ ok: false })
    expect(assetBuildSourceDraft({ ...base, target: { ...target, path: '/secondary/*/assetId' } })).toMatchObject({ ok: false })
    expect(payload).toEqual({ note: '保留原草稿' })
  })

  it('finds only actual active saved references and does not count uncreated optional positions', () => {
    // 防重复提示按真实保存正文和条件，不因类型声明中存在路径就判定已引用。
    expect(assetReadSourceReferences(documentType, { note: '尚未引用' })).toEqual([])
    expect(assetReadSourceReferences(documentType, { note: '真实secondary',
      secondary: { kind: 'asset', assetId: file.id, mediaType: file.mediaType } }))
      .toEqual([{ path: '/secondary/assetId', assetId: file.id }])
    expect(assetReadSourceReferences(documentType, { note: '条件不满足',
      secondary: { kind: 'url', assetId: file.id, mediaType: file.mediaType } })).toEqual([])
  })
})
