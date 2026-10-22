// 仅调用真实公开定义解析器，确认104已承诺修复的自有键站点；无外部服务或数据库。
const { definitionsReadPackage, definitionsValidateCatalog } = require('../../backend/modules/shared/data-definition.ts')
const labels = Object.fromEntries([['__proto__', '原型同名标签'], ['normal', '普通标签']])
const source = {
  id: 'audit.labels', version: 1, title: 'labels', schemaDialect: 'http://json-schema.org/draft-07/schema#',
  dataTypes: [{ id: 'audit.choice', version: 1, title: 'choice',
    schema: { type: 'object', properties: { choice: { type: 'string', enum: ['__proto__', 'normal'] } }, required: ['choice'], additionalProperties: false },
    references: [], successorTypes: [], presentation: { enumLabels: { '/choice': labels } },
    agentProjection: { include: ['/choice'], mapEntryFilters: [] } }],
  transitions: [], dependencies: { packages: [], agents: [] },
}
const catalog = definitionsValidateCatalog([definitionsReadPackage(source)])
const result = catalog.dataTypes[0].presentation.enumLabels['/choice']
console.log(JSON.stringify({ case: 'P01-unfinished-enum-label', catalogAccepted: true, inputOwnProto: Object.hasOwn(labels, '__proto__'),
  parsedOwnProto: Object.hasOwn(result, '__proto__'), parsedKeys: Object.keys(result), normalRetained: result.normal === labels.normal }))
for (const field of ['fieldLabels', 'enumLabels']) {
  const input = structuredClone(source)
  input.dataTypes[0].presentation = { [field]: Object.fromEntries([['__proto__', field === 'fieldLabels' ? '配置标签' : { normal: '普通标签' }]]) }
  const parsed = definitionsReadPackage(input).dataTypes[0].presentation[field]
  console.log(JSON.stringify({ case: 'P01-unfinished-presentation-map', field, packageAccepted: true, parsedOwnProto: Object.hasOwn(parsed, '__proto__'),
    ordinaryPrototype: Object.getPrototypeOf(parsed) === Object.prototype }))
}
