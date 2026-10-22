// 验证初始化必须显式提供完整阶段，且不能绕过共享 Agent 与工具约束。
import { describe, expect, it } from 'vitest'

import { seedReadInput } from '../../../../backend/modules/workspace/seed-configuration'
import { verificationConfiguration } from '../../fixtures/verification'

describe('complete workspace seeds', () => {
  // 当前种子输入不再接受历史配置的缺阶段形状。
  it('rejects missing parse and split stages instead of filling deployment defaults', () => {
    // 分别移除两个必要阶段，确认边界拒绝不完整输入。
    const seed = verificationConfiguration()
    const { parse, split, ...verificationOnly } = seed
    for (const input of [verificationOnly, { ...verificationOnly, parse }, { ...verificationOnly, split }]) {
      expect(() => /* 解析缺少阶段的初始化输入。 */ seedReadInput(input))
        .toThrowError(expect.objectContaining({ code: 'DEFAULT_CONFIGURATION_INVALID' }))
    }
  })

  it('keeps the supplied stage profiles and returns independent configuration values', () => {
    // 完整种子按原值解析，修改解析结果不会污染输入或默认模板。
    const input = verificationConfiguration()
    const parsed = seedReadInput(input)
    expect(parsed).toEqual(input)
    parsed.split.agents[0].tools.push('changed-after-validation')
    expect(input.split.agents[0].tools).not.toContain('changed-after-validation')
  })

  it('rejects duplicate Agent identities across stages and unregistered capabilities', () => {
    // 完整阶段结构不能绕过跨阶段身份冲突、保留工具和工具目录校验。
    const duplicate = verificationConfiguration()
    duplicate.parse.id = duplicate.router.id
    expect(() => /* 解析跨阶段身份冲突的种子。 */ seedReadInput(duplicate))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))

    const missingTool = verificationConfiguration()
    missingTool.split.agents[0].tools = ['unregistered_tool']
    expect(() => /* 解析引用未注册工具的种子。 */ seedReadInput(missingTool))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))

    const reservedTool = verificationConfiguration()
    reservedTool.tools.push({ name: 'data_propose', description: 'Host-owned capability' })
    expect(() => /* 解析试图注册宿主保留工具的种子。 */ seedReadInput(reservedTool))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
  })

  it.each([
    ['defaultPriority', 'high'],
    ['claimCategory', 'quote'],
  ])('rejects an array that stringifies to a valid %s', (
    /* 应为枚举标量的外部配置字段。 */ field,
    /* 只有单元素数组的字符串转换才会产生的合法枚举文字。 */ value,
  ) => {
    // 初始化边界必须拒绝错误 JSON 类型，不能先转换成标量再接受。
    const seed = verificationConfiguration()
    Object.assign(seed.parse, { [field]: [value] })
    expect(() => /* 由真实种子入口解析畸形枚举字段。 */ seedReadInput(seed))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
  })
})
