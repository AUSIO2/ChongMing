// 对共享白名单入口验证字段名称，不以字符串真值判断是否找到未知字段。
import { describe, expect, it } from 'vitest'

import { inputReadObject } from '../../../../backend/modules/shared/input-validation'

describe('input object field ownership', () => {
  // 空键仍是自有字段，必须遵守调用方声明的白名单。
  it('rejects an unknown empty field and accepts it only when explicitly allowed', () => {
    // 两个输入仅白名单不同，避免被其他无效字段提前拒绝。
    const input = { '': 'content', name: 'kept' }
    expect(() => inputReadObject(input, ['name'], 'params')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    expect(inputReadObject(input, ['', 'name'], 'params')).toBe(input)
  })
})
