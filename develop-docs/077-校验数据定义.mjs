// 077 协议样例自检：只验证声明和样例，不连接数据库、RabbitMQ 或 DSH。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Ajv = require('ajv')
const example = JSON.parse(readFileSync(new URL('./077-数据定义示例.json', import.meta.url), 'utf8'))
// 这些数值只是自检预算，不是 Host、Agent 或生产工作流的固定容量上限。
const limits = example.fixtures.limits
for (const value of Object.values(limits)) assert(Number.isSafeInteger(value) && value > 0, 'invalid fixture budget')
const dialect = 'http://json-schema.org/draft-07/schema#'
const ajv = new Ajv({ allErrors: true, jsonPointers: true, schemaId: '$id', format: 'full' })
const clone = value => JSON.parse(JSON.stringify(value))
const record = value => !!value && typeof value === 'object' && !Array.isArray(value)
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : record(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value)
const unique = values => new Set(values).size === values.length
const sameMembers = (a, b) => canonical([...a].sort()) === canonical([...b].sort())

function checkKeys(value, allowed, required = allowed) {
  assert(record(value), 'expected object')
  for (const key of Object.keys(value)) assert(allowed.includes(key), 'unknown field: ' + key)
  for (const key of required) assert(Object.hasOwn(value, key), 'missing field: ' + key)
}

function refKey(ref) {
  checkKeys(ref, ['id', 'version'])
  assert(typeof ref.id === 'string' && /^[a-z][a-z0-9.-]*$/.test(ref.id), 'invalid definition id')
  // 类型/转换版本在目录中要求从 1 开始；Agent 绑定允许沿用现有 revision=0。
  assert(Number.isSafeInteger(ref.version) && ref.version >= 0, 'invalid definition version')
  return ref.id + '@' + ref.version
}

// 同一确切版本只能登记同一内容；重复请求可以重放，修改必须发布新版本。
function registerDefinitions(definitions, registry = new Map()) {
  for (const definition of definitions) {
    const key = refKey({ id: definition.id, version: definition.version })
    if (registry.has(key)) assert.equal(canonical(registry.get(key)), canonical(definition), 'immutable version conflict: ' + key)
    else registry.set(key, clone(definition))
  }
  return registry
}

function resolve(registry, ref, label) {
  const key = refKey(ref)
  assert(registry.has(key), 'unknown ' + label + ': ' + key)
  return registry.get(key)
}

const schemaKeys = new Set(['$schema', '$ref', 'definitions', 'title', 'description', 'default', 'type', 'properties',
  'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength',
  'minimum', 'maximum', 'enum', 'const', 'oneOf', 'format'])

// 限定 draft-07 的声明能力，未知关键字直接报错，绝不忽略后假装验证成功。
function checkSchemaSubset(schema, root = schema) {
  assert(record(schema), 'only object schemas are supported')
  for (const key of Object.keys(schema)) assert(schemaKeys.has(key), 'unsupported schema keyword: ' + key)
  if (schema.$schema !== undefined) assert.equal(schema.$schema, dialect, 'unsupported schema dialect')
  if (schema.$ref !== undefined) {
    assert(/^#\/definitions\/[A-Za-z][A-Za-z0-9_-]*$/.test(schema.$ref), 'only local definitions references are allowed')
    assert(root.definitions?.[schema.$ref.split('/')[2]], 'unresolved local schema reference')
    assert(Object.keys(schema).every(key => ['$ref', 'description', 'title'].includes(key)), 'ref siblings cannot hide validation rules')
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    assert(types.every(type => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)), 'unsupported JSON type')
    if (Array.isArray(schema.type)) assert(types.length === 2 && unique(types) && types.includes('null'), 'only nullable type unions are supported')
  }
  if (schema.type === 'object') assert(Object.hasOwn(schema, 'additionalProperties'), 'object must explicitly define additionalProperties')
  if (schema.additionalProperties !== undefined) {
    assert(schema.additionalProperties === false || record(schema.additionalProperties), 'additionalProperties must be false or a schema')
    if (record(schema.additionalProperties)) checkSchemaSubset(schema.additionalProperties, root)
  }
  for (const key of ['properties', 'definitions']) if (schema[key] !== undefined) {
    assert(record(schema[key]), key + ' must be an object')
    for (const child of Object.values(schema[key])) checkSchemaSubset(child, root)
  }
  if (schema.items !== undefined) {
    assert(!Array.isArray(schema.items), 'tuple arrays are not supported')
    checkSchemaSubset(schema.items, root)
  }
  if (schema.type === 'array') assert(schema.items, 'array items schema is required')
  if (schema.format !== undefined) assert(['date-time', 'uri', 'uuid'].includes(schema.format), 'unsupported format')
  if (schema.oneOf !== undefined) {
    assert(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2 && schema.oneOf.length <= limits.maxOneOfVariants, 'finite oneOf exceeds fixture budget')
    const tags = schema.oneOf.map(variant => {
      checkSchemaSubset(variant, root)
      assert(variant.type === 'object' && variant.required?.includes('kind'), 'oneOf needs required kind discriminator')
      assert(typeof variant.properties?.kind?.const === 'string', 'oneOf kind must have a string const')
      return variant.properties.kind.const
    })
    assert(unique(tags), 'oneOf discriminators must differ')
  }
}

// 本地引用允许复用结构，不允许递归 schema；避免把文档样例扩成通用递归解释器。
function checkSchemaReferences(root) {
  const visiting = new Set(), checked = new Set()
  function scan(schema) {
    if (schema.$ref) visit(schema.$ref.split('/')[2])
    for (const child of Object.values(schema.properties ?? {})) scan(child)
    if (record(schema.additionalProperties)) scan(schema.additionalProperties)
    if (schema.items) scan(schema.items)
    for (const variant of schema.oneOf ?? []) scan(variant)
  }
  function visit(name) {
    assert(!visiting.has(name), 'recursive schema reference is not supported')
    if (checked.has(name)) return
    assert(root.definitions?.[name], 'unresolved local schema reference')
    visiting.add(name); scan(root.definitions[name]); visiting.delete(name); checked.add(name)
  }
  scan(root)
  for (const name of Object.keys(root.definitions ?? {})) visit(name)
}

function pointerParts(pointer) {
  assert(typeof pointer === 'string' && /^\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/.test(pointer), 'invalid payload pointer')
  return pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function schemaAt(schema, pointer, root = schema) {
  function visit(current, parts, depth = 0) {
    assert(depth < limits.maxSchemaReferenceDepth, 'schema reference exceeds fixture budget')
    if (current.$ref) return visit(root.definitions[current.$ref.split('/')[2]], parts, depth + 1)
    if (!parts.length) return [current]
    if (current.oneOf) return current.oneOf.flatMap(variant => visit(variant, parts, depth + 1))
    const [head, ...rest] = parts
    const next = head === '*' ? current.items ?? current.additionalProperties : current.properties?.[head]
    return record(next) ? visit(next, rest, depth + 1) : []
  }
  return visit(schema, pointerParts(pointer))
}

function valuesAt(payload, pointer) {
  function visit(value, parts) {
    if (!parts.length) return [value]
    if (!value || typeof value !== 'object') return []
    const [head, ...rest] = parts
    if (head === '*') return Object.values(value).flatMap(child => visit(child, rest))
    return Object.hasOwn(value, head) ? visit(value[head], rest) : []
  }
  return visit(payload, pointerParts(pointer))
}

// 类型定义先全量登记再解析确切引用，支持同一发布批次中的前向引用。
function buildCatalog(data) {
  assert.equal(data.schemaDialect, dialect)
  const types = registerDefinitions(data.dataTypes)
  const transitions = registerDefinitions(data.transitions)
  const agents = registerDefinitions(data.fixtures.agents)
  const assets = new Set(data.fixtures.assets.map(asset => {
    assert.equal(asset.fixtureOnly, true)
    return asset.id
  }))
  for (const agent of agents.values()) assert.equal(agent.fixtureOnly, true, 'external Agent fixtures must be inert')
  const validators = new Map()
  for (const [key, type] of types) {
    checkKeys(type, ['id', 'version', 'title', 'schema', 'successorTypes', 'references', 'agentProjection'])
    assert(type.version >= 1, 'type versions start at 1')
    assert.equal(type.schema.$schema, dialect)
    checkSchemaSubset(type.schema)
    checkSchemaReferences(type.schema)
    assert(ajv.validateSchema(type.schema), 'invalid schema: ' + ajv.errorsText())
    validators.set(key, ajv.compile(type.schema))
    assert(unique(type.successorTypes.map(refKey)), 'duplicate successor type')
    for (const successor of type.successorTypes) resolve(types, successor, 'successor type')
    for (const reference of type.references) {
      checkKeys(reference, ['path', 'target', 'when'], ['path', 'target'])
      assert(schemaAt(type.schema, reference.path).length, 'reference path is absent from schema')
      const target = reference.target
      if (target.kind === 'node') {
        checkKeys(target, ['kind', 'types'])
        assert(target.types.length > 0)
        for (const ref of target.types) resolve(types, ref, 'reference target type')
      } else { checkKeys(target, ['kind']); assert.equal(target.kind, 'asset') }
      if (reference.when) {
        checkKeys(reference.when, ['path', 'equals'])
        assert(schemaAt(type.schema, reference.when.path).length, 'reference condition path is absent from schema')
      }
    }
    checkKeys(type.agentProjection, ['include', 'mapEntryFilters'])
    assert(unique(type.agentProjection.include), 'duplicate projection path')
    for (const path of type.agentProjection.include) {
      assert(!pointerParts(path).includes('*'), 'projection include must select a concrete schema field')
      assert(schemaAt(type.schema, path).length, 'projection path is absent from schema')
    }
    for (const filter of type.agentProjection.mapEntryFilters) {
      checkKeys(filter, ['path', 'visibleWhen'])
      assert(type.agentProjection.include.some(path => filter.path === path || filter.path.startsWith(path + '/')), 'filter must be inside projection')
      assert(schemaAt(type.schema, filter.path + '/*/' + filter.visibleWhen).some(field => field.type === 'boolean'), 'visibility discriminator must be a boolean field')
    }
  }
  const catalog = { types, transitions, agents, assets, validators }
  for (const transition of transitions.values()) checkTransition(transition, catalog)
  return catalog
}

function checkCount(count) {
  checkKeys(count, ['min', 'max'])
  assert(Number.isSafeInteger(count.min) && Number.isSafeInteger(count.max) && count.min >= 0 && count.max >= count.min, 'invalid count bounds')
}

// 结构输入和 context 分开；基数与后继许可只检查结构输入和最终发布输出。
function checkTransition(transition, catalog) {
  checkKeys(transition, ['id', 'version', 'title', 'ports', 'cardinality', 'group', 'execution', 'review'])
  refKey({ id: transition.id, version: transition.version })
  assert(transition.version >= 1, 'transition versions start at 1')
  checkKeys(transition.ports, ['input', 'context', 'output'])
  const { input, context, output } = transition.ports
  assert(input.length && output.length, 'at least one input and output port is required')
  assert(unique([...input, ...context, ...output].map(port => port.name)), 'port names must be unique')
  for (const port of [...input, ...context, ...output]) {
    assert(typeof port.name === 'string' && /^[a-z][a-z0-9-]*$/.test(port.name), 'invalid port name')
    checkCount(port.count)
  }
  for (const port of [...input, ...context]) {
    checkKeys(port, ['name', 'inputType', 'count'])
    resolve(catalog.types, port.inputType, 'input type')
  }
  for (const port of output) {
    checkKeys(port, ['name', 'outputType', 'count', 'successorOf'])
    resolve(catalog.types, port.outputType, 'output type')
    assert(port.successorOf.length && unique(port.successorOf), 'output needs unique structural anchor ports')
    for (const name of port.successorOf) {
      const anchor = input.find(item => item.name === name)
      assert(anchor, 'successorOf must refer to a structural input port, never context')
      const type = resolve(catalog.types, anchor.inputType, 'anchor type')
      assert(type.successorTypes.some(ref => refKey(ref) === refKey(port.outputType)), 'successor type/version is not permitted')
    }
  }
  const totals = ports => ({ min: ports.reduce((n, port) => n + port.count.min, 0), max: ports.reduce((n, port) => n + port.count.max, 0) })
  const i = totals(input), o = totals(output)
  assert(i.min >= 1, 'a transition must have a structural input')
  assert(['1:1', '1:N', 'N:1', 'N:M'].includes(transition.cardinality), 'unknown cardinality')
  if (transition.cardinality.startsWith('1:')) assert(i.min === 1 && i.max === 1, 'cardinality conflicts with input count')
  else assert(i.max >= 2, 'N input cardinality needs multiple-input capacity')
  if (transition.cardinality.endsWith(':1')) assert(o.min === 1 && o.max === 1, 'cardinality conflicts with output count')
  else assert(o.max >= 2, 'N/M output cardinality needs multiple-output capacity')
  assert.deepEqual(transition.group, { mode: 'explicit-members', ready: 'sealed-all-required' })
  checkKeys(transition.execution, ['stages', 'resultStage'])
  const stages = transition.execution.stages
  assert(stages.length >= 1 && stages.length <= limits.maxStages && unique(stages.map(stage => stage.id)), 'stage count exceeds fixture budget or ids repeat')
  const stageMap = new Map(stages.map(stage => [stage.id, stage]))
  for (const stage of stages) {
    checkKeys(stage, ['id', 'kind', 'agentRef', 'dependsOn', 'ready', 'resultMode', 'outputPorts'])
    assert.equal(stage.kind, 'agent')
    assert.equal(stage.ready, 'all-dependencies')
    resolve(catalog.agents, stage.agentRef, 'Agent fixture')
    assert(unique(stage.dependsOn), 'duplicate stage dependency')
    for (const id of stage.dependsOn) assert(stageMap.has(id), 'unknown stage dependency')
    assert(['outputs', 'selection'].includes(stage.resultMode), 'unknown stage resultMode')
    if (stage.resultMode === 'selection') assert(stage.dependsOn.length, 'selection needs candidate dependencies')
    assert(stage.outputPorts.length && unique(stage.outputPorts.map(port => port.port)), 'stage outputPorts must be unique')
    for (const declared of stage.outputPorts) {
      checkKeys(declared, ['port', 'count']); checkCount(declared.count)
      assert(output.some(port => port.name === declared.port), 'stage refers to unknown operation output port')
    }
    if (stage.id === transition.execution.resultStage) {
      assert.equal(canonical(stage.outputPorts), canonical(output.map(port => ({ port: port.name, count: port.count }))), 'resultStage must use operation output counts')
    }
  }
  const visited = new Set(), visiting = new Set()
  function visit(id) {
    assert(stageMap.has(id), 'unknown result stage')
    assert(!visiting.has(id), 'stage dependency cycle')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of stageMap.get(id).dependsOn) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  visit(transition.execution.resultStage)
  assert.equal(visited.size, stages.length, 'every stage must contribute to resultStage')
  checkKeys(transition.review, ['mode', 'at', 'onReject'])
  assert(['none', 'required'].includes(transition.review.mode))
  assert.equal(transition.review.at, 'result'); assert.equal(transition.review.onReject, 'fail')
}

function validateNode(node, catalog) {
  checkKeys(node, ['id', 'revision', 'typeId', 'typeVersion', 'payload'])
  assert(typeof node.id === 'string' && node.id.length > 0)
  assert(Number.isSafeInteger(node.revision) && node.revision >= 0, 'invalid node revision')
  const ref = { id: node.typeId, version: node.typeVersion }
  resolve(catalog.types, ref, 'type')
  const validate = catalog.validators.get(refKey(ref))
  assert(validate(node.payload), 'invalid payload: ' + ajv.errorsText(validate.errors))
}

function validateReferences(node, nodes, catalog) {
  const type = resolve(catalog.types, { id: node.typeId, version: node.typeVersion }, 'type')
  for (const reference of type.references) {
    if (reference.when && !valuesAt(node.payload, reference.when.path).some(value => value === reference.when.equals)) continue
    for (const id of valuesAt(node.payload, reference.path)) {
      assert(typeof id === 'string', 'reference must contain an id')
      if (reference.target.kind === 'asset') assert(catalog.assets.has(id), 'unknown fixture asset')
      else {
        const target = nodes.get(id)
        assert(target, 'unknown referenced node')
        assert(reference.target.types.some(ref => ref.id === target.typeId && ref.version === target.typeVersion), 'referenced node type mismatch')
      }
    }
  }
}

// 这里只投影示例 payload；生产系统仍须先验证访问权限，不能把此函数当作鉴权。
function projectForAgent(node, catalog) {
  const type = resolve(catalog.types, { id: node.typeId, version: node.typeVersion }, 'type')
  const projected = {}
  for (const pointer of type.agentProjection.include) {
    const values = valuesAt(node.payload, pointer)
    if (!values.length) continue
    const parts = pointerParts(pointer)
    let target = projected
    for (const part of parts.slice(0, -1)) {
      assert(!['__proto__', 'constructor', 'prototype'].includes(part), 'unsafe projection key')
      target = target[part] ??= {}
    }
    assert(!['__proto__', 'constructor', 'prototype'].includes(parts.at(-1)), 'unsafe projection key')
    target[parts.at(-1)] = clone(values[0])
  }
  for (const filter of type.agentProjection.mapEntryFilters) {
    for (const map of valuesAt(projected, filter.path)) {
      assert(record(map), 'mapEntryFilters only accepts object maps')
      for (const [key, value] of Object.entries(map)) if (!record(value) || value[filter.visibleWhen] !== true) delete map[key]
    }
  }
  return projected
}

// 封闭组清单、输入版本与输出锚点共同描述一次 N→M；context 不取得结构写范围。
function validateInvocation(invocation, nodes, catalog) {
  checkKeys(invocation, ['id', 'transitionRef', 'inputs', 'context', 'outputs', 'group', 'outputAnchors', 'stageResults', 'published'])
  const transition = resolve(catalog.transitions, invocation.transitionRef, 'transition')
  function checkPorts(ports, values, direction) {
    assert(record(values) && sameMembers(Object.keys(values), ports.map(port => port.name)), 'port names do not match declaration')
    for (const port of ports) {
      const ids = values[port.name]
      assert(Array.isArray(ids) && unique(ids), 'port node ids must be unique')
      assert(ids.length >= port.count.min && ids.length <= port.count.max, 'sample count violates port bounds')
      const ref = port[direction === 'output' ? 'outputType' : 'inputType']
      for (const id of ids) {
        const node = nodes.get(id)
        assert(node, 'unknown sample node')
        assert(node.typeId === ref.id && node.typeVersion === ref.version, 'port node type/version mismatch')
      }
    }
  }
  checkPorts(transition.ports.input, invocation.inputs, 'input')
  checkPorts(transition.ports.context, invocation.context, 'input')
  checkPorts(transition.ports.output, invocation.outputs, 'output')
  checkKeys(invocation.group, ['id', 'sealed', 'completed', 'expectedInputs'])
  assert(invocation.group.sealed === true && invocation.group.completed === true, 'group must be sealed and complete')
  assert(sameMembers(Object.keys(invocation.group.expectedInputs), Object.keys(invocation.inputs)), 'group ports mismatch')
  for (const [port, ids] of Object.entries(invocation.inputs)) assert(sameMembers(ids, invocation.group.expectedInputs[port]), 'group membership mismatch')
  const outputIds = Object.values(invocation.outputs).flat()
  assert(unique(outputIds), 'one output instance cannot occupy two output slots')
  assert(sameMembers(Object.keys(invocation.outputAnchors), outputIds), 'output anchors do not match outputs')
  const consumed = new Set([...Object.values(invocation.inputs).flat(), ...Object.values(invocation.context).flat()])
  for (const port of transition.ports.output) {
    const allowed = new Set(port.successorOf.flatMap(name => invocation.inputs[name]))
    for (const id of invocation.outputs[port.name]) {
      assert(!consumed.has(id), 'sample transitions must create new output instances')
      const anchors = invocation.outputAnchors[id]
      assert(Array.isArray(anchors) && anchors.length && unique(anchors), 'output must have unique actual anchors')
      for (const anchor of anchors) assert(allowed.has(anchor), 'output anchor is outside successorOf')
      const node = nodes.get(id), type = catalog.types.get(refKey({ id: node.typeId, version: node.typeVersion }))
      for (const reference of type.references.filter(item => item.target.kind === 'node')) {
        if (reference.when && !valuesAt(node.payload, reference.when.path).some(value => value === reference.when.equals)) continue
        for (const target of valuesAt(node.payload, reference.path)) assert(consumed.has(target) || outputIds.includes(target), 'output reference is absent from provenance inputs')
      }
    }
  }
  validateStageResults(invocation, transition, nodes, catalog)
}

// 中间阶段只验证自己的候选预算；最终阶段另按 Operation 基数校验，选择不能伪造候选。
function validateStageResults(invocation, transition, nodes, catalog) {
  const stages = new Map(transition.execution.stages.map(stage => [stage.id, stage]))
  assert(unique(invocation.stageResults.map(result => result.stageId)), 'duplicate stage result')
  assert(unique(invocation.stageResults.map(result => result.workId)), 'fixture Work ids must be unique')
  assert(sameMembers(invocation.stageResults.map(result => result.stageId), [...stages.keys()]), 'missing stage results')
  const results = new Map(invocation.stageResults.map(result => [result.stageId, result])), resolved = new Map()
  const identity = ref => JSON.stringify([ref.workId, ref.key])
  function resolveStage(id) {
    if (resolved.has(id)) return resolved.get(id)
    const stage = stages.get(id), result = results.get(id)
    checkKeys(result, ['stageId', 'workId', stage.resultMode])
    assert(typeof result.workId === 'string' && result.workId.length, 'missing fixture Work id')
    const values = result[stage.resultMode]
    assert(Array.isArray(values), 'stage outputs/selection must be an array')
    const inherited = new Map(stage.dependsOn.flatMap(dependency => [...resolveStage(dependency)]))
    const candidates = new Map(), counts = new Map(stage.outputPorts.map(port => [port.port, 0]))
    for (const value of values) {
      if (stage.resultMode === 'outputs') {
        checkKeys(value, ['key', 'port', 'typeRef', 'payload'])
        assert(typeof value.key === 'string' && value.key.length, 'invalid candidate key')
        const port = transition.ports.output.find(port => port.name === value.port)
        assert(port && counts.has(port.name), 'stage refers to undeclared output port')
        assert.equal(refKey(value.typeRef), refKey(port.outputType), 'candidate typeRef differs from output port')
        const validate = catalog.validators.get(refKey(port.outputType))
        assert(validate(value.payload), 'invalid stage candidate payload: ' + ajv.errorsText(validate.errors))
        const anchors = [...new Set(port.successorOf.flatMap(name => invocation.inputs[name]))]
        assert(anchors.length, 'candidate needs a structural anchor')
        const ref = { workId: result.workId, key: value.key }, key = identity(ref)
        assert(!candidates.has(key), 'duplicate Work candidate key')
        candidates.set(key, { payload: value.payload, anchors, port: port.name, ref })
        counts.set(port.name, counts.get(port.name) + 1)
      } else {
        checkKeys(value, ['workId', 'key'])
        const key = identity(value), candidate = inherited.get(key)
        assert(candidate && counts.has(candidate.port), 'selection references unknown or wrong-port candidate')
        assert(!candidates.has(key), 'candidate selected more than once')
        candidates.set(key, candidate)
        counts.set(candidate.port, counts.get(candidate.port) + 1)
      }
    }
    for (const declared of stage.outputPorts) {
      const count = counts.get(declared.port)
      assert(count >= declared.count.min && count <= declared.count.max, 'stage candidate count violation')
    }
    resolved.set(id, candidates)
    return candidates
  }
  const finalCandidates = resolveStage(transition.execution.resultStage)
  assert.equal(invocation.published.length, finalCandidates.size, 'publication count must match final candidates')
  const consumed = new Set(), publishedNodes = new Set()
  for (const publication of invocation.published) {
    checkKeys(publication, ['port', 'candidate', 'nodeId']); checkKeys(publication.candidate, ['workId', 'key'])
    const key = identity(publication.candidate), candidate = finalCandidates.get(key)
    assert(candidate && candidate.port === publication.port, 'published result is not a final candidate')
    assert(!consumed.has(key) && !publishedNodes.has(publication.nodeId), 'publication identity must be unique')
    consumed.add(key); publishedNodes.add(publication.nodeId)
    assert(invocation.outputs[publication.port]?.includes(publication.nodeId), 'publication node is not an operation output')
    assert.equal(canonical(nodes.get(publication.nodeId).payload), canonical(candidate.payload), 'published payload differs from selected candidate')
    assert(sameMembers(invocation.outputAnchors[publication.nodeId], candidate.anchors), 'published anchors differ from candidate')
  }
  assert(sameMembers([...publishedNodes], Object.values(invocation.outputs).flat()), 'publication mapping does not cover all outputs')
}

function makeNodeRef(node) {
  return { id: node.id, revision: node.revision, typeRef: { id: node.typeId, version: node.typeVersion } }
}

// 边仅表达实际结构；生成记录另外保留全部读输入和版本，不能由边数量推断来源。
function validateGraphSamples(samples, nodes, catalog) {
  assert(unique(samples.invocations.map(item => item.id)), 'duplicate invocation id')
  assert(unique(samples.derivations.map(item => item.id)), 'duplicate derivation id')
  assert(unique(samples.edges.map(item => item.id)), 'duplicate edge id')
  assert.equal(samples.derivations.length, samples.invocations.length, 'one derivation record is required per invocation')
  const expectedEdges = [], owners = new Set()
  for (const invocation of samples.invocations) {
    validateInvocation(invocation, nodes, catalog)
    const derivation = samples.derivations.find(item => item.invocationId === invocation.id)
    assert(derivation, 'missing derivation record')
    checkKeys(derivation, ['id', 'invocationId', 'transitionRef', 'inputRefs', 'contextRefs', 'outputRefs'])
    assert.equal(canonical(derivation.transitionRef), canonical(invocation.transitionRef))
    for (const [source, target] of [['inputs', 'inputRefs'], ['context', 'contextRefs'], ['outputs', 'outputRefs']]) {
      const expected = Object.fromEntries(Object.entries(invocation[source]).map(([name, ids]) => [name, ids.map(id => makeNodeRef(nodes.get(id)))]))
      assert.equal(canonical(derivation[target]), canonical(expected), 'provenance member/version mismatch')
    }
    for (const [output, anchors] of Object.entries(invocation.outputAnchors)) {
      assert(!owners.has(output), 'output instance has multiple producers'); owners.add(output)
      for (const from of anchors) expectedEdges.push({ role: 'successor', from, to: output, derivationId: derivation.id })
      for (const from of Object.values(invocation.context).flat()) expectedEdges.push({ role: 'reference', from, to: output, derivationId: derivation.id })
    }
  }
  const actualEdges = samples.edges.map(edge => {
    checkKeys(edge, ['id', 'revision', 'role', 'from', 'to', 'derivationId'])
    assert(Number.isSafeInteger(edge.revision) && edge.revision >= 0)
    assert(nodes.has(edge.from) && nodes.has(edge.to) && edge.from !== edge.to, 'invalid edge endpoints')
    assert(['successor', 'reference'].includes(edge.role))
    if (edge.role === 'successor') {
      const from = nodes.get(edge.from), to = nodes.get(edge.to)
      const type = catalog.types.get(refKey({ id: from.typeId, version: from.typeVersion }))
      assert(type.successorTypes.some(ref => ref.id === to.typeId && ref.version === to.typeVersion), 'actual successor edge is not permitted')
    }
    const { id, revision, ...structure } = edge
    return structure
  })
  assert.deepEqual(actualEdges.map(canonical).sort(), expectedEdges.map(canonical).sort(), 'actual edges disagree with anchors/context')
}

const catalog = buildCatalog(example)
const nodes = new Map()
for (const node of example.samples.nodes) {
  assert(!nodes.has(node.id), 'duplicate node id')
  validateNode(node, catalog); nodes.set(node.id, node)
}
for (const node of nodes.values()) validateReferences(node, nodes, catalog)
validateGraphSamples(example.samples, nodes, catalog)
const projectedNews = projectForAgent(nodes.get('news-1'), catalog)
assert(Object.hasOwn(projectedNews.context, 'public'))
assert(!Object.hasOwn(projectedNews.context, 'private'), 'hidden context must not reach Agent')
assert.equal(Object.values(example.samples.invocations.find(item => item.id === 'split-empty').outputs).flat().length, 0)
registerDefinitions(example.dataTypes, catalog.types) // 完全相同的发布请求可重放。
// 保留既有 Agent revision=0 的引用语义，不要求用户先改动 Agent 配置才能绑定。
const legacyAgentExample = clone(example)
const legacyAgentId = legacyAgentExample.fixtures.agents[0].id
legacyAgentExample.fixtures.agents[0].version = 0
for (const transition of legacyAgentExample.transitions) for (const stage of transition.execution.stages) {
  if (stage.agentRef.id === legacyAgentId) stage.agentRef.version = 0
}
assert(buildCatalog(legacyAgentExample).agents.has(legacyAgentId + '@0'))

const negatives = []
function rejects(name, action, message) {
  assert.throws(action, error => error instanceof assert.AssertionError && message.test(error.message), name)
  negatives.push(name)
}
function changedTransition(id, change) {
  const transition = clone(catalog.transitions.get(id + '@1')); change(transition); checkTransition(transition, catalog)
}
function changedInvocation(id, change) {
  const invocation = clone(example.samples.invocations.find(item => item.id === id)); change(invocation); validateInvocation(invocation, nodes, catalog)
}

rejects('unknown type', () => validateNode({ ...nodes.get('claim-1'), typeId: 'missing.type' }, catalog), /unknown type/)
rejects('unknown type version', () => validateNode({ ...nodes.get('claim-1'), typeVersion: 2 }, catalog), /unknown type/)
rejects('illegal payload', () => validateNode({ ...nodes.get('opinion-1'), payload: { score: 2, reason: 'invalid', evidenceIds: [] } }, catalog), /invalid payload/)
rejects('extra payload field', () => validateNode({ ...nodes.get('claim-1'), payload: { ...nodes.get('claim-1').payload, ignored: true } }, catalog), /invalid payload/)
rejects('nullable is not arbitrary scalar', () => validateNode({ ...nodes.get('claim-1'), payload: { content: 'x', category: 42 } }, catalog), /invalid payload/)
rejects('invalid locator variant', () => validateNode({ ...nodes.get('source-1'), payload: { label: null, locator: { kind: 'url', assetId: 'fixture-article' } } }, catalog), /invalid payload/)
rejects('invalid timestamp format', () => validateNode({ ...nodes.get('evidence-1'), payload: { ...nodes.get('evidence-1').payload, capturedAt: '2026-99-99T00:00:00Z' } }, catalog), /invalid payload/)
rejects('invalid URI format', () => validateNode({ ...nodes.get('source-1'), payload: { label: null, locator: { kind: 'url', url: 'not a URI' } } }, catalog), /invalid payload/)
rejects('unknown Agent fixture', () => changedTransition('writing.summarize', t => { t.execution.stages[0].agentRef = { id: 'missing.agent', version: 1 } }), /unknown Agent fixture/)
rejects('count/cardinality conflict', () => changedTransition('writing.summarize', t => { t.ports.output[0].count.max = 2 }), /cardinality conflicts/)
rejects('inverted count bounds', () => changedTransition('writing.summarize', t => { t.ports.output[0].count = { min: 2, max: 1 } }), /invalid count bounds/)
rejects('sample output count violation', () => changedInvocation('summarize-1', i => { i.outputs.summary = [] }), /sample count/)
rejects('N:M input count violation', () => changedInvocation('batch-1', i => { i.inputs.documents = ['document-1'] }), /sample count/)
rejects('forbidden successor type', () => changedTransition('writing.summarize', t => { t.ports.output[0].outputType = { id: 'factcheck.claim', version: 1 } }), /successor type\/version/)
rejects('context is not a structural anchor', () => changedTransition('factcheck.form-opinion', t => { t.ports.output[0].successorOf = ['evidence'] }), /never context/)
rejects('actual output anchor mismatch', () => changedInvocation('opinion-a', i => { i.outputAnchors['opinion-1'] = ['evidence-1'] }), /outside successorOf/)
rejects('unsealed group', () => changedInvocation('merge-1', i => { i.group.sealed = false }), /sealed and complete/)
rejects('group member omission', () => changedInvocation('merge-1', i => { i.group.expectedInputs.opinions.pop() }), /group membership/)
rejects('stage cycle', () => changedTransition('writing.summarize', t => { t.execution.stages[0].dependsOn = ['summarize'] }), /dependency cycle/)
rejects('result stage total count mismatch', () => changedTransition('writing.batch-summarize', t => { t.execution.stages.at(-1).outputPorts[0].count.min = 0 }), /resultStage must use/)
rejects('unknown selection candidate', () => changedInvocation('opinion-a', i => { i.stageResults.at(-1).selection[0].key = 'invented' }), /selection references unknown/)
rejects('duplicate candidate selection', () => changedInvocation('batch-1', i => { i.stageResults.at(-1).selection[1] = clone(i.stageResults.at(-1).selection[0]) }), /selected more than once/)
rejects('different content under same version', () => registerDefinitions([{ ...example.dataTypes[0], title: 'changed published definition' }], catalog.types), /immutable version conflict/)
rejects('type version zero', () => {
  const changed = clone(example); changed.dataTypes[0].version = 0; buildCatalog(changed)
}, /type versions start at 1/)
rejects('transition version zero', () => {
  const changed = clone(example); changed.transitions[0].version = 0; buildCatalog(changed)
}, /transition versions start at 1/)
rejects('unsupported schema keyword', () => checkSchemaSubset({ type: 'string', pattern: '.*' }), /unsupported schema keyword/)
rejects('remote schema ref', () => checkSchemaSubset({ $ref: 'https://example.org/schema.json' }), /only local/)
rejects('recursive local schema ref', () => checkSchemaReferences({ definitions: { self: { $ref: '#/definitions/self' } } }), /recursive schema reference/)
rejects('unknown type cannot be projected', () => projectForAgent({ ...nodes.get('news-1'), typeId: 'missing.type' }, catalog), /unknown type/)
rejects('wrong provenance revision', () => {
  const samples = clone(example.samples); samples.derivations[0].inputRefs.source[0].revision++
  validateGraphSamples(samples, nodes, catalog)
}, /provenance member\/version/)

console.log('077 协议样例检查通过：' + catalog.types.size + ' 个类型、' + catalog.transitions.size + ' 个转换、'
  + nodes.size + ' 个节点、' + example.samples.invocations.length + ' 次示意转换、' + example.samples.edges.length + ' 条关系。')
console.log('通过 ' + negatives.length + ' 项负例；已检查空输出、敏感 context 投影、确切版本引用及 N→M 来源。')
console.log('此脚本仅检查字段、引用、基数与样例图一致性；数据库事务、Work 租约、消息、审核和真实 DSH 由生产自动化测试验证，本脚本不执行 Agent。')
