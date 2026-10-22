// 验证定义目录、schema payload 校验和执行规格冻结的通用协议。
import { assert, describe, expect, it } from 'vitest'

import type { DataSchema, DefinitionPackage, ExecutionAgentDefinition } from '../../../../contracts/data-definition'
import {
  definitionsFreezeExecution,
  definitionsReadPackage,
  definitionsReadPayloadReferences,
  definitionsValidateCatalog,
  definitionsValidatePayload,
} from '../../../../backend/modules/shared/data-definition'
import { DEFAULT_DEFINITION_PACKAGE, DEFAULT_WORKSPACE_SEED } from '../../../../apps/config/default-prompts'
import { graphParseNodePayload } from '../../../../backend/modules/shared/data-reference-index'
import { messageFormat, RuntimeMessage } from '../../../../contracts/messages'

function definitionTestAgents(): ExecutionAgentDefinition[] {
  // 将默认提示词资源按初始配置版本投影为定义校验使用的精确 Agent 目录。
  const configuration = DEFAULT_WORKSPACE_SEED
  const profiles = [configuration.parse, configuration.split.router, ...configuration.split.agents, configuration.split.merger,
    configuration.router, ...configuration.agents, configuration.merger]
  return profiles.map(profile => /* 初始种子配置使用版本零。 */ ({ ref: { id: profile.id, version: 0 }, profile }))
}

function definitionDictionaryPackage(
  /* 正例或故意包含未声明名称的原始 schema，由实际包解析入口读取。 */ schema: unknown,
): DefinitionPackage {
  // 建立不依赖Agent的单类型包，单独验证schema字典的声明与引用规则。
  return definitionsReadPackage({ id: 'fixture.dictionary-package', version: 1, title: '字典声明',
    schemaDialect: 'http://json-schema.org/draft-07/schema#',
    dataTypes: [{ id: 'fixture.dictionary', version: 1, title: '字典字段', schema,
      successorTypes: [], references: [], agentProjection: { include: [], mapEntryFilters: [] } }],
    transitions: [], dependencies: { packages: [], agents: [] } })
}

describe('Registered data definitions', () => {
  // 覆盖默认包、精确版本冲突、payload 约束和不可变执行闭包。
  it.each(['toString', 'constructor', '__proto__'])('rejects undeclared payload field %s', (
    /* Object.prototype同名但未在properties声明的字段。 */ name,
  ) => {
    // additionalProperties:false不能被原型上的函数或对象冒充已声明子schema。
    const catalog = definitionsValidateCatalog([definitionDictionaryPackage({ type: 'object', properties: {}, additionalProperties: false })])
    expect(() => definitionsValidatePayload(catalog, { id: 'fixture.dictionary', version: 1 }, Object.fromEntries([[name, 'undeclared']])))
      .toThrowError(/does not allow/)
  })

  it.each(['toString', 'constructor', '__proto__'])('preserves and validates explicitly declared field %s', (
    /* 显式合法字段可以与Object.prototype属性同名。 */ name,
  ) => {
    // 自有声明和自有正文都必须保留，不能为了拒绝继承字段而禁用合法名称。
    const catalog = definitionsValidateCatalog([definitionDictionaryPackage({ type: 'object',
      properties: Object.fromEntries([[name, { type: 'integer' }]]), required: [name], additionalProperties: false })])
    const payload = Object.fromEntries([[name, 2]])
    expect(definitionsValidatePayload(catalog, { id: 'fixture.dictionary', version: 1 }, payload)).toEqual(payload)
    expect(() => definitionsValidatePayload(catalog, { id: 'fixture.dictionary', version: 1 }, {})).toThrowError(/missing/)
    expect(() => definitionsValidatePayload(catalog, { id: 'fixture.dictionary', version: 1 }, Object.fromEntries([[name, 'wrong-type']])))
      .toThrowError(/wrong type/)
  })

  it.each(['toString', 'constructor', '__proto__'])('rejects required field %s without its own declaration', (
    /* required中出现但properties实际未声明的字段。 */ name,
  ) => {
    // required不能把继承属性当成类型中已经定义的字段。
    expect(() => definitionsValidateCatalog([definitionDictionaryPackage({ type: 'object', properties: {}, required: [name] })]))
      .toThrowError(/required/)
  })

  it('allows empty required without properties and rejects nonempty undeclared required', () => {
    // 空required没有字段义务；非空声明仍必须能在实际properties中定位到schema。
    const catalog = definitionsValidateCatalog([definitionDictionaryPackage({ type: 'object', required: [], additionalProperties: false })])
    expect(definitionsValidatePayload(catalog, { id: 'fixture.dictionary', version: 1 }, {})).toEqual({})
    expect(() => definitionsValidateCatalog([definitionDictionaryPackage({ type: 'object', required: ['missing'] })])).toThrowError(/required/)
  })

  it.each(['toString', 'constructor'])('rejects an undeclared local definition %s', (
    /* 本地$ref引用了Object.prototype同名但未声明的定义。 */ name,
  ) => {
    // 发布校验应当在引用出现处拒绝缺失定义，而不是把原型方法解释成空schema。
    expect(() => definitionsValidateCatalog([definitionDictionaryPackage({ type: 'object',
      properties: { value: { $ref: `#/definitions/${name}` } }, definitions: {} })]))
      .toThrowError(/missing definition/)
  })

  it.each(['toString', 'constructor'])('resolves an explicitly declared local definition %s', (
    /* 本地definitions确实声明的合法同名定义。 */ name,
  ) => {
    // 同名本地定义仍按其真实schema校验正文，不能一律禁止原型名称。
    const catalog = definitionsValidateCatalog([definitionDictionaryPackage({ type: 'object',
      properties: { value: { $ref: `#/definitions/${name}` } }, required: ['value'], additionalProperties: false,
      definitions: Object.fromEntries([[name, { type: 'integer' }]]) })])
    expect(definitionsValidatePayload(catalog, { id: 'fixture.dictionary', version: 1 }, { value: 2 })).toEqual({ value: 2 })
    expect(() => definitionsValidatePayload(catalog, { id: 'fixture.dictionary', version: 1 }, { value: 'wrong-type' })).toThrowError(/wrong type/)
  })

  it.each(['toString', 'constructor', '__proto__'])('rejects presentation path /%s without its own field', (
    /* 展示路径引用但schema未声明的同名字段。 */ name,
  ) => {
    // 目录路径解析只接受显式properties，继承字段不能成为有效展示目标。
    const source = definitionDictionaryPackage({ type: 'object', properties: {} })
    source.dataTypes[0].presentation = { titlePath: `/${name}` }
    expect(() => definitionsValidateCatalog([source])).toThrowError(/presentation path/)
  })

  it('preserves labels for a legal prototype-named enum value in a published definition', () => {
    // 枚举正文与对应标签都是合法字符串，自有__proto__标签不得被setter吞掉。
    const source = definitionDictionaryPackage({ type: 'object', properties: {
      value: { type: 'string', enum: ['__proto__', 'normal'] },
    }, required: ['value'], additionalProperties: false })
    const labels = Object.fromEntries([['__proto__', '特殊名称'], ['normal', '普通值']])
    source.dataTypes[0].presentation = { fieldLabels: { '/value': '选项' }, enumLabels: { '/value': labels } }
    const parsed = definitionsReadPackage(source)
    const presentation = parsed.dataTypes[0].presentation
    assert(presentation?.enumLabels)
    expect(presentation.enumLabels['/value']).toEqual(labels)
    expect(Object.prototype.hasOwnProperty.call(presentation.enumLabels['/value'], '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(presentation.enumLabels['/value'])).toBe(Object.prototype)
    const catalog = definitionsValidateCatalog([source])
    expect(definitionsValidatePayload(catalog, { id: 'fixture.dictionary', version: 1 }, { value: '__proto__' })).toEqual({ value: '__proto__' })
  })

  it('copies every own key in both outer presentation label maps', () => {
    // 此处只验证parser保存字典的语义，不将任意标签键当成UI可消费的JSON Pointer。
    const source = definitionDictionaryPackage({ type: 'object', properties: {} })
    const keys = ['__proto__', 'constructor', 'toString', '/ordinary']
    const fieldLabels = Object.fromEntries(keys.map((/* 原型同名键及一个普通路径对照。 */ key) =>
      /* 为每个自有键保存不同的非空展示文字。 */ [key, `字段${key}`]))
    const enumLabels = Object.fromEntries(keys.map((/* 原型同名键及普通路径的外层映射。 */ key) =>
      /* 内层正常值使本例只验证外层映射构造。 */ [key, { normal: `选项${key}` }]))
    source.dataTypes[0].presentation = { fieldLabels, enumLabels }
    const presentation = definitionsReadPackage(source).dataTypes[0].presentation
    assert(presentation)
    expect(presentation.fieldLabels).toEqual(fieldLabels)
    expect(presentation.enumLabels).toEqual(enumLabels)
    expect(Object.getPrototypeOf(presentation.fieldLabels)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(presentation.enumLabels)).toBe(Object.prototype)
    for (const key of keys) {
      expect(Object.prototype.hasOwnProperty.call(presentation.fieldLabels, key)).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(presentation.enumLabels, key)).toBe(true)
    }
  })

  it('accepts general scalar schemas while keeping graph payload roots as validated objects', () => {
    // 通用定义可以使用标量，但图节点协议仍要求对象，不能靠断言接受合法 schema 下的标量根。
    const changed = structuredClone(DEFAULT_DEFINITION_PACKAGE)
    changed.id = 'fixture.scalar'
    const typeRef = { id: 'fixture.scalar', version: 1 }
    changed.dataTypes.push({ ...typeRef, title: '标量定义', schema: { type: 'string' },
      successorTypes: [], references: [], agentProjection: { include: [], mapEntryFilters: [] } })
    const catalog = definitionsValidateCatalog([changed], definitionTestAgents())

    expect(definitionsValidatePayload(catalog, typeRef, 'valid scalar')).toBe('valid scalar')
    expect(() => /* 图专用入口不能让标量正文进入持久化图。 */ graphParseNodePayload(catalog, typeRef, 'valid scalar'))
      .toThrowError(messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_OBJECT, 'payload'))
    expect(() => /* 对象根也必须完成实际 schema 校验，不能绕过必填正文。 */ graphParseNodePayload(catalog,
      { id: 'factcheck.claim', version: 1 }, {})).toThrowError(/Payload/)
  })
  it('rejects inherited names as declared stage variables', () => {
    // Object.prototype上的名称不能替代实际阶段绑定授予提示词变量。
    const agents = structuredClone(definitionTestAgents())
    agents[0].profile.promptVars = ['toString']
    expect(() => /* 对完整生产定义执行真实跨阶段变量校验。 */ definitionsValidateCatalog([DEFAULT_DEFINITION_PACKAGE], agents))
      .toThrowError(/undeclared prompt variable/)
  })

  it('requires own payload fields even when their names exist on Object.prototype', () => {
    // required只接受实际JSON字段，同时允许显式提供同名的合法正文。
    const changed = structuredClone(DEFAULT_DEFINITION_PACKAGE)
    changed.id = 'fixture.own-fields'
    const typeRef = { id: 'fixture.own-fields', version: 1 }
    const field: DataSchema = { type: 'string' }
    changed.dataTypes.push({ ...typeRef, title: '自有字段', successorTypes: [], references: [],
      agentProjection: { include: [], mapEntryFilters: [] }, schema: { type: 'object',
        properties: { toString: field }, required: ['toString'], additionalProperties: false } })
    const catalog = definitionsValidateCatalog([changed], definitionTestAgents())
    expect(() => /* 缺失同名自有字段时不能借用原型方法。 */ definitionsValidatePayload(catalog, typeRef, {}))
      .toThrowError(/missing toString/)
    expect(definitionsValidatePayload(catalog, typeRef, { toString: '真实内容' })).toEqual({ toString: '真实内容' })
  })

  it('validates the production package and freezes exact Agent, tool and output contracts', () => {
    // 验证默认包的类型/转换引用完整，并让同一输入稳定生成自包含执行规格。
    const catalog = definitionsValidateCatalog([DEFAULT_DEFINITION_PACKAGE], definitionTestAgents(), 7)
    expect(catalog).toMatchObject({ revision: 7 })
    expect(catalog.dataTypes.map(type => /* 返回注册类型身份。 */ type.id)).toEqual([
      'factcheck.source', 'factcheck.news', 'factcheck.claim', 'factcheck.opinion', 'factcheck.verification',
    ])
    const input = {
      catalog, transitionRef: { id: 'factcheck.parse-source', version: 1 }, agents: definitionTestAgents(),
      tools: DEFAULT_WORKSPACE_SEED.tools,
      inputs: { source: [{ id: 'source-1', revision: 3, type: { id: 'factcheck.source', version: 1 } }] }, context: {},
    }
    const first = definitionsFreezeExecution(input), second = definitionsFreezeExecution(input)
    expect(first.specHash).toBe(second.specHash)
    expect(first.stages[0]).toMatchObject({ id: 'parse', agent: { ref: { id: 'parse-extract', version: 0 } },
      outputContract: { mode: 'outputs', ports: [{ port: 'news', successorOf: [{ source: 'input', port: 'source' }] }] } })
    expect(first.stages[0].agent.profile).not.toBe(DEFAULT_WORKSPACE_SEED.parse)
  })

  it('reports cardinality for a missing required constructor port instead of reading its prototype', () => {
    // 声明端口与原型同名时，缺省绑定仍必须得到受控基数错误。
    const definition = structuredClone(DEFAULT_DEFINITION_PACKAGE)
    const transition = definition.transitions.find((/* 默认包中的独立来源解析转换。 */ item) =>
      /* 选择只有一个输入端口的真实生产合同。 */ item.id === 'factcheck.parse-source')
    assert(transition, 'parse-source fixture is missing')
    transition.ports.input[0].name = 'constructor'
    for (const port of transition.ports.output) for (const anchor of port.successorOf) if (anchor.source === 'input') anchor.port = 'constructor'
    for (const stage of transition.execution.stages) {
      assert(stage.promptBindings, 'parse-source fixture requires prompt bindings')
      for (const binding of Object.values(stage.promptBindings)) {
        if (binding.source === 'input' || binding.source === 'source-text') binding.port = 'constructor'
      }
    }
    const agents = definitionTestAgents()
    const catalog = definitionsValidateCatalog([definition], agents)
    expect(() => /* 未提供必需端口只能按空集合触发基数错误。 */ definitionsFreezeExecution({ catalog,
      transitionRef: { id: transition.id, version: transition.version }, agents, tools: DEFAULT_WORKSPACE_SEED.tools, inputs: {}, context: {},
    })).toThrowError(expect.objectContaining({ code: 'OUTPUT_CARDINALITY' }))
  })

  it('validates payloads without defaults or coercion and rejects changed immutable versions', () => {
    // 验证内容严格遵守精确 schema，并拒绝用相同包版本替换不同定义。
    const agents = definitionTestAgents()
    const catalog = definitionsValidateCatalog([DEFAULT_DEFINITION_PACKAGE], agents)
    expect(definitionsValidatePayload(catalog, { id: 'factcheck.claim', version: 1 }, { content: '可核查陈述', category: null }))
      .toEqual({ content: '可核查陈述', category: null })
    expect(definitionsReadPayloadReferences(catalog, { id: 'factcheck.opinion', version: 1 }, {
      score: 0.5, reason: '待进一步核对', evidenceClaimIds: ['claim-a', 'claim-b'],
    })).toEqual(['claim-a', 'claim-b'].map((
      /* 已展开的陈述身份。 */ value, /* 通配数组引用的具体下标。 */ index) => /* 引用必须绑定精确 Claim 类型，而不能只返回同名节点身份。 */ ({
        value, path: `/evidenceClaimIds/${index}`, parent: ['claim-a', 'claim-b'], definition: { path: '/evidenceClaimIds/*', target: { kind: 'node', types: [{ id: 'factcheck.claim', version: 1 }] } },
      }),
    ))
    expect(() => /* 退役字段不能作为新 Opinion 的 payload 继续写入。 */ definitionsValidatePayload(catalog,
      { id: 'factcheck.opinion', version: 1 }, { score: 0.5, reason: '旧证据字段', evidenceIds: [] })).toThrowError(/Payload/)
    expect(() => /* 默认目录不再注册独立 Evidence，历史类型也不能回落到 Claim。 */ definitionsValidatePayload(catalog,
      { id: 'factcheck.evidence', version: 1 }, { content: '旧证据' })).toThrowError(/not found/)
    expect(() => /* category 未在默认定义枚举中，必须拒绝而不能强制转换。 */ definitionsValidatePayload(catalog,
      { id: 'factcheck.claim', version: 1 }, { content: '可核查陈述', category: 'other' })).toThrowError(/Payload/)
    const changed: DefinitionPackage = structuredClone(DEFAULT_DEFINITION_PACKAGE)
    changed.title = 'Changed in place'
    expect(() => /* 同一 package id/version 内容变化违反不可变发布约定。 */ definitionsValidateCatalog([DEFAULT_DEFINITION_PACKAGE, changed], agents))
      .toThrowError(/different content/)
  })

  it('rejects output anchor cycles before a transition can be published', () => {
    // 验证同批输出锚点必须形成有向无环结构，防止发布关系自相依赖。
    const changed: DefinitionPackage = structuredClone(DEFAULT_DEFINITION_PACKAGE)
    const transition = changed.transitions.find(item => /* 按稳定转换身份定位默认核查流程。 */ item.id === 'factcheck.verify-claim')
    if (!transition) throw new Error('Fixture transition is missing')
    transition.ports.output[0].successorOf = [{ source: 'output', port: 'verification' }]
    expect(() => /* 输出意见和结论互相作为结构锚点时发布必须失败。 */ definitionsValidateCatalog([changed], definitionTestAgents()))
      .toThrowError(/cycle|not an allowed successor/)
  })

  it('applies outer object constraints after selecting one oneOf branch', () => {
    // oneOf 只选择判别分支，不能绕过同层 required 和 additionalProperties 等共同约束。
    const changed: DefinitionPackage = structuredClone(DEFAULT_DEFINITION_PACKAGE)
    changed.id = 'fixture.oneof'; changed.version = 1
    changed.dataTypes.push({
      id: 'fixture.oneof-value', version: 1, title: '判别对象', successorTypes: [], references: [],
      agentProjection: { include: [], mapEntryFilters: [] },
      schema: {
        type: 'object', properties: { common: { type: 'string' }, kind: { type: 'string' } }, required: ['common'], additionalProperties: false,
        oneOf: [
          { type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'], additionalProperties: {} },
          { type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'], additionalProperties: {} },
        ],
      },
    })
    const catalog = definitionsValidateCatalog([changed], definitionTestAgents())
    expect(() => definitionsValidatePayload(catalog, { id: 'fixture.oneof-value', version: 1 }, { kind: 'a' })).toThrowError(/missing common/)
    expect(definitionsValidatePayload(catalog, { id: 'fixture.oneof-value', version: 1 }, { kind: 'a', common: 'ok' }))
      .toEqual({ kind: 'a', common: 'ok' })
  })

  it('requires every cross-package type reference in the exact dependency closure', () => {
    // 发布成功的包必须能够仅凭声明依赖导出并重新构建同一目录。
    const type = (id: string, successorTypes: Array<{ id: string; version: number }>): DefinitionPackage => ({
      id: `${id}.package`, version: 1, title: id, schemaDialect: 'http://json-schema.org/draft-07/schema#',
      dataTypes: [{ id, version: 1, title: id, schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        successorTypes, references: [], agentProjection: { include: [], mapEntryFilters: [] } }],
      transitions: [], dependencies: { packages: [], agents: [] },
    })
    const first = type('fixture.first', []), second = type('fixture.second', [{ id: 'fixture.first', version: 1 }])
    expect(() => definitionsValidateCatalog([first, second])).toThrowError(/omits package dependency/)
    second.dependencies.packages.push({ id: first.id, version: first.version })
    expect(definitionsValidateCatalog([first, second]).dataTypes).toHaveLength(2)
  })
})
