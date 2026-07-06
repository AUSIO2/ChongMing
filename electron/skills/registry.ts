/** 内置技能元数据 — 供 UI 多选；运行实例见 electron/tools */

export type SkillRequiredKey = 'tavilyApiKey'

export interface SkillDescriptor {
  id: string
  displayLabel: string
  description: string
  requiredKeys: SkillRequiredKey[]
}

const SKILL_REGISTRY: SkillDescriptor[] = [
  {
    id: 'web_search',
    displayLabel: '网页搜索',
    description: '检索公开网页，用于核实来源与交叉验证（Tavily API）',
    requiredKeys: ['tavilyApiKey'],
  },
]

export function skillList(): SkillDescriptor[] {
  return SKILL_REGISTRY.map(s => ({ ...s, requiredKeys: [...s.requiredKeys] }))
}

export function skillReadIds(): string[] {
  return SKILL_REGISTRY.map(s => s.id)
}
