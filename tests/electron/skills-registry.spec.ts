import { describe, expect, it } from 'vitest'
import { skillList } from '../../electron/skills/registry'

describe('skillList', () => {
  it('包含 web_search 技能元数据', () => {
    const skills = skillList()
    expect(skills.some(s => s.id === 'web_search')).toBe(true)
    const web = skills.find(s => s.id === 'web_search')
    expect(web?.requiredKeys).toContain('tavilyApiKey')
    expect(web?.displayLabel).toBeTruthy()
  })
})
