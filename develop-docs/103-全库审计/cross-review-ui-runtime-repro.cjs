// 独立复核UI合法schema准入与真实资产正文构造路径；不接服务。
const path = require('node:path'), fs = require('node:fs'), ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const definitions = require(path.join(root, 'backend/modules/shared/data-definition.ts'))
const payloadModule = require(path.join(root, 'apps/ui/features/graph/data-payload.ts'))
const extract = (file, names) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  const ast = ts.createSourceFile(file + '.ts', source, ts.ScriptTarget.Latest, true)
  return ts.transpileModule(ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
}
const makeType = (id, schema, references = []) => ({ id, version: 1, title: id, schema, references, successorTypes: [], agentProjection: { include: [], mapEntryFilters: [] } })
const dictionary = makeType('audit.dictionary', { type: 'object', additionalProperties: { type: 'string' } })
const asset = makeType('audit.asset', { type: 'object', properties: Object.fromEntries([['__proto__', { type: 'object', properties: { assetId: { type: 'string' } }, required: ['assetId'], additionalProperties: false }]]), additionalProperties: false }, [{ path: '/__proto__/assetId', target: { kind: 'asset' } }])
const pack = definitions.definitionsReadPackage({ id: 'audit.ui.boundaries', version: 1, title: 'UI concrete admissibility', schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes: [dictionary, asset], transitions: [], dependencies: { packages: [], agents: [] } })
const catalog = definitions.definitionsValidateCatalog([pack])
definitions.definitionsValidatePayload(catalog, { id: dictionary.id, version: 1 }, { field: 'valid text' })
let renamed
const rename = new Function('objectValue', 'emit', extract('apps/ui/features/graph/DataPayloadEditor.vue', ['editorRenameObject']) + ';return editorRenameObject')({ value: { field: 'valid text' } }, (_event, value) => { renamed = value })
rename('field', '__proto__')
console.log(JSON.stringify({ case: 'U10-rename-valid-string', inputValidatedByPublishedSchema: true, resultingJson: JSON.stringify(renamed), ownProto: Object.hasOwn(renamed, '__proto__') }))
const create = new Function('payloadCreateInitial', 'payloadResolveSchema', extract('apps/ui/features/assets/AssetManagement.vue', ['assetSetPointer', 'assetSchemaHasPointer', 'assetCreatePayload']) + ';return assetCreatePayload')(payloadModule.payloadCreateInitial, payloadModule.payloadResolveSchema)
const publishedAssetType = catalog.dataTypes.find(type => type.id === asset.id)
try {
  const result = create({ id: 'audit-file', filename: 'audit.txt', mediaType: 'text/plain' }, publishedAssetType, publishedAssetType.references[0])
  console.log(JSON.stringify({ case: 'U10-full-asset-constructor', publishedCatalogValid: true, qualifiesRealSourceTypeSelector: publishedAssetType.references.some(ref => ref.target.kind === 'asset'), initialOptionalContainer: true, resultingJson: JSON.stringify(result), prototypeChanged: Object.prototype.assetId === 'audit-file' }))
} finally { delete Object.prototype.assetId }
