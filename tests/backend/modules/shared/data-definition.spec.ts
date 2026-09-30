// 验证定义目录、schema payload 校验和执行规格冻结的通用协议。
import { describe, expect, it } from 'vitest'

import type { DefinitionPackage, ExecutionAgentDefinition } from '../../../../contracts/data-definition'
import {
  definitionsFreezeExecution,
  definitionsReadPayloadReferences,
  definitionsValidateCatalog,
  definitionsValidatePayload,
} from '../../../../backend/modules/shared/data-definition'
import { DEFAULT_DEFINITION_PACKAGE, DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'

function definitionTestAgents(): ExecutionAgentDefinition[] {
  // 将默认提示词资源按初始配置版本投影为定义校验使用的精确 Agent 目录。
  const configuration = DEFAULT_RUN_CONFIGURATION
  const profiles = [configuration.parse, configuration.split.router, ...configuration.split.agents, configuration.split.merger,
    configuration.router, ...configuration.agents, configuration.merger]
  return profiles.map(profile => /* 初始种子配置使用版本零。 */ ({ ref: { id: profile.id, version: 0 }, profile }))
}

describe('Registered data definitions', () => {
  // 覆盖默认包、精确版本冲突、payload 约束和不可变执行闭包。
  it('validates the production package and freezes exact Agent, tool and output contracts', () => {
    // 验证默认包的类型/转换引用完整，并让同一输入稳定生成自包含执行规格。
    const catalog = definitionsValidateCatalog([DEFAULT_DEFINITION_PACKAGE], definitionTestAgents(), 7)
    expect(catalog).toMatchObject({ revision: 7 })
    expect(catalog.dataTypes.map(type => /* 返回注册类型身份。 */ type.id)).toEqual([
      'factcheck.source', 'factcheck.news', 'factcheck.claim', 'factcheck.evidence', 'factcheck.opinion', 'factcheck.verification',
    ])
    const input = {
      catalog, transitionRef: { id: 'factcheck.parse-source', version: 1 }, agents: definitionTestAgents(),
      tools: DEFAULT_RUN_CONFIGURATION.tools,
      inputs: { source: [{ id: 'source-1', revision: 3, type: { id: 'factcheck.source', version: 1 } }] }, context: {},
    }
    const first = definitionsFreezeExecution(input), second = definitionsFreezeExecution(input)
    expect(first.specHash).toBe(second.specHash)
    expect(first.stages[0]).toMatchObject({ id: 'parse', agent: { ref: { id: 'parse-extract', version: 0 } },
      outputContract: { mode: 'outputs', ports: [{ port: 'news', successorOf: [{ source: 'input', port: 'source' }] }] } })
    expect(first.stages[0].agent.profile).not.toBe(DEFAULT_RUN_CONFIGURATION.parse)
  })

  it('validates payloads without defaults or coercion and rejects changed immutable versions', () => {
    // 验证内容严格遵守精确 schema，并拒绝用相同包版本替换不同定义。
    const agents = definitionTestAgents()
    const catalog = definitionsValidateCatalog([DEFAULT_DEFINITION_PACKAGE], agents)
    expect(definitionsValidatePayload(catalog, { id: 'factcheck.claim', version: 1 }, { content: '可核查陈述', category: null }))
      .toEqual({ content: '可核查陈述', category: null })
    expect(definitionsReadPayloadReferences(catalog, { id: 'factcheck.opinion', version: 1 }, {
      score: 0.5, reason: '待进一步核对', evidenceIds: ['evidence-a', 'evidence-b'],
    }).map(reference => /* 返回星号路径展开后的节点身份。 */ reference.value)).toEqual(['evidence-a', 'evidence-b'])
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
