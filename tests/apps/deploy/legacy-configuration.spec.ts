// 验证一次旧部署配置规划只更新已确认的stock正文，不写数据库或修改用户配置。
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentProfile, ClusterSettings, PromptKind } from '../../../contracts/control'
import type { DefinitionPackage, ExecutionAgentDefinition } from '../../../contracts/data-definition'
import type { GraphAgentProfile } from '../../../contracts/graph-agent'
import { DEFAULT_WORKSPACE_SEED } from '../../../apps/config/default-prompts'
import { definitionsValidateCatalog } from '../../../backend/modules/shared/data-definition'
import { CONTROL_PROMPT_VARIABLES } from '../../../backend/modules/workspace/workspace-input'
import { planLegacyConfigurationUpgrade } from '../../../scripts/deploy/legacy-configuration'

const now = '2026-10-22T00:00:00.000Z'
const settings: ClusterSettings = { revision: 7, llm: { provider: 'existing-provider', model: 'existing-model' },
  tools: structuredClone(DEFAULT_WORKSPACE_SEED.tools), limits: { maxAgentSlots: 8 } }

function fixture(): { agents: AgentProfile[]; definitionPackages?: DefinitionPackage[]; definitionAgents?: ExecutionAgentDefinition[]; hashes: Record<string, string> } {
  // 将真实默认模板构造成旧版已保存Agent，保留作用域独立身份与可继承模型。
  const agents: AgentProfile[] = [], hashes: Record<string, string> = {}, defaults = DEFAULT_WORKSPACE_SEED
  function append(/* 当前真实模板，正文用于之后的升级对照。 */ template: GraphAgentProfile, /* 已保存的旧角色。 */ kind: PromptKind, /* 稳定模板路径。 */ promptPath: string): void {
    // 仅用可区分的旧正文替换content，其余配置照真实seedProfile协议构造。
    const content = `Previous stock persona for ${template.id}`
    agents.push({ ...structuredClone(template), id: `saved-${template.id}`, kind, promptPath, content, provider: null, model: null,
      promptVars: [...(CONTROL_PROMPT_VARIABLES[kind] ?? [])], defaultPriority: template.defaultPriority ?? 'medium',
      claimCategory: template.claimCategory ?? null, revision: 0, deletable: kind === 'splitSubAgent' || kind === 'verifySubAgent', updatedAt: '2026-01-01T00:00:00.000Z' })
    hashes[promptPath] = createHash('sha256').update(content).digest('hex')
  }
  append(defaults.parse, 'parseExtract', 'fact-parser/extract')
  append(defaults.split.router, 'splitRoute', 'fact-extractor/main-agent-route')
  append(defaults.split.merger, 'splitMerge', 'fact-extractor/main-agent-merge')
  for (const template of defaults.split.agents) append(template, 'splitSubAgent', `fact-extractor/sub-agents/${template.id}`)
  append(defaults.router, 'verifyRoute', 'fact-verifier/main-agent-route')
  append(defaults.merger, 'verifyMerge', 'fact-verifier/main-agent-merge')
  for (const template of defaults.agents) append(template, 'verifySubAgent', `fact-verifier/sub-agents/${template.id}`)
  return { agents, hashes }
}

describe('one-time legacy deployment configuration planner', () => {
  // 保护旧未注册部署的附加式升级，不把该工具扩大成通用配置迁移器。
  it('updates eleven exact stock contents, preserves all metadata and plans a valid five-type three-transition catalog', () => {
    // 全部stock匹配时仅升级正文和Agent版本，旧快照与新快照分别保存。
    const source = fixture(), before = structuredClone(source), result = planLegacyConfigurationUpgrade(source, settings, source.hashes, now)
    expect(source).toEqual(before)
    expect(result.changed).toBe(true)
    expect(result.updatedAgentIds).toHaveLength(11)
    expect(result.definitionAgents).toHaveLength(22)
    for (const original of source.agents) {
      const upgraded = result.agents.find((/* 候选作用域内Agent。 */ agent) => /* 按原身份定位，不能改成默认模板ID。 */ agent.id === original.id)
      if (!upgraded) throw new Error('Expected every existing Agent to remain')
      expect(upgraded.revision).toBe(1)
      expect(upgraded.updatedAt).toBe(now)
      expect(upgraded.content).not.toBe(original.content)
      expect({ ...upgraded, content: original.content, revision: original.revision, updatedAt: original.updatedAt }).toEqual(original)
      expect(result.definitionAgents).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: { id: original.id, version: 0 }, profile: expect.objectContaining({ content: original.content, provider: settings.llm.provider, model: settings.llm.model }) }),
        expect.objectContaining({ ref: { id: original.id, version: 1 }, profile: expect.objectContaining({ content: upgraded.content }) }),
      ]))
    }
    const catalog = definitionsValidateCatalog(result.definitionPackages, result.definitionAgents)
    expect(catalog.dataTypes).toHaveLength(5)
    expect(catalog.transitions).toHaveLength(3)
    for (const transition of catalog.transitions) for (const stage of transition.execution.stages) {
      expect(stage.agentRef.id).toMatch(/^saved-/)
      expect(stage.agentRef.version).toBe(1)
      if (stage.plan) expect(stage.plan.agentRefs).toHaveLength(3)
    }
  })

  it('preserves a user-edited worker and its version while upgrading the other stock profiles', () => {
    // 旧stock摘要不匹配时不改正文或任何元数据，计划仍引用该用户Agent的原精确版本。
    const source = fixture(), custom = source.agents.find((/* 原作用域Agent。 */ agent) => /* 选择一个实际核查worker。 */ agent.kind === 'verifySubAgent')
    if (!custom) throw new Error('Expected an existing verification worker')
    custom.content = 'User-specific verification instructions'
    custom.revision = 4
    custom.model = 'user-model'
    const before = structuredClone(custom), result = planLegacyConfigurationUpgrade(source, settings, source.hashes, now)
    expect(result.agents.find((/* 候选作用域Agent。 */ agent) => /* 对照用户原身份。 */ agent.id === custom.id)).toEqual(before)
    expect(result.updatedAgentIds).not.toContain(custom.id)
    expect(result.updatedAgentIds).toHaveLength(10)
    const catalog = definitionsValidateCatalog(result.definitionPackages, result.definitionAgents)
    const verify = catalog.transitions.find((/* 已规划的正式转换。 */ transition) => /* 读取核查计划候选。 */ transition.id === 'factcheck.verify-claim')
    const route = verify?.execution.stages.find((/* 该转换的阶段。 */ stage) => /* 定位路由允许的worker集合。 */ stage.id === 'route')
    expect(route?.plan?.agentRefs).toContainEqual({ id: custom.id, version: 4 })
  })

  it('adds transitions beside a data-only package, preserves archived references and becomes a no-op once complete', () => {
    // 已迁移类型由原包继续拥有，历史精确快照不被当前Agent重写，重跑也不再升级。
    const source = fixture(), first = source.agents[0]
    if (!first) throw new Error('Expected the parser profile')
    const archived: ExecutionAgentDefinition = { ref: { id: first.id, version: 0 }, profile: {
      id: first.id, name: first.name, description: first.description, content: 'Previously frozen persona', tools: [], provider: 'archived-provider', model: 'archived-model', promptVars: [...first.promptVars] } }
    source.definitionAgents = [archived]
    source.definitionPackages = [{ ...structuredClone(DEFAULT_WORKSPACE_SEED.definitionPackage), id: 'chongming.fact-checking-data-migration',
      title: 'Migrated data', transitions: [], dependencies: { packages: [], agents: [] } }]
    const result = planLegacyConfigurationUpgrade(source, settings, source.hashes, now)
    expect(result.definitionAgents.find((/* 归档或新增快照。 */ agent) => /* 定位已有精确历史引用。 */ agent.ref.id === first.id && agent.ref.version === 0)).toEqual(archived)
    expect(result.definitionPackages).toHaveLength(2)
    const added = result.definitionPackages[1]
    expect(added?.dataTypes).toEqual([])
    expect(added?.dependencies.packages).toEqual([{ id: 'chongming.fact-checking-data-migration', version: 1 }])
    expect(definitionsValidateCatalog(result.definitionPackages, result.definitionAgents).transitions).toHaveLength(3)
    const repeated = planLegacyConfigurationUpgrade(result, settings, source.hashes, '2026-10-23T00:00:00.000Z')
    expect(repeated).toEqual({ ...result, updatedAgentIds: [], changed: false })
  })

  it('rejects missing fixed roles or conflicting type ownership before mutating the source', () => {
    // 非完整旧部署与重复类型归属不能通过删定义、猜角色或覆盖原内容来修补。
    const missing = fixture()
    missing.agents = missing.agents.filter((/* 已保存的角色配置。 */ agent) => /* 明确移除唯一解析角色。 */ agent.kind !== 'parseExtract')
    expect(() => { /* 缺角色必须在任何候选写入前拒绝。 */ planLegacyConfigurationUpgrade(missing, settings, missing.hashes, now) }).toThrow()
    const conflict = fixture(), dataOnly = { ...structuredClone(DEFAULT_WORKSPACE_SEED.definitionPackage), transitions: [], dependencies: { packages: [], agents: [] } }
    conflict.definitionPackages = [dataOnly, { ...structuredClone(dataOnly), id: 'another-owner' }]
    const before = structuredClone(conflict)
    expect(() => { /* 相同类型版本即便内容相同，也不能属于两个包。 */ planLegacyConfigurationUpgrade(conflict, settings, conflict.hashes, now) }).toThrow()
    expect(conflict).toEqual(before)
  })
})
