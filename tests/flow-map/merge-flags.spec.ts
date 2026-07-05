import { describe, expect, it } from 'vitest'
import {
  mergeReadShouldSave,
  mergeUpdateClaims,
  mergeUpdateDraftFlags,
} from '../../electron/shared/merge-flags'

describe('merge-flags', () => {
  it('mergeReadShouldSave 解析 JSON 数组', () => {
    expect(mergeReadShouldSave('[{"draftIndex":1,"shouldSave":false}]')).toEqual([
      { draftIndex: 1, shouldSave: false },
    ])
  })

  it('mergeUpdateClaims 按 draftIndex 标 shouldSave', () => {
    const drafts = [{ content: 'a', shouldSave: true }, { content: 'b', shouldSave: true }]
    const out = mergeUpdateClaims(drafts, [
      { draftIndex: 1, shouldSave: false },
    ])
    expect(out[0].shouldSave).toBe(true)
    expect(out[1].shouldSave).toBe(false)
  })

  it('mergeUpdateDraftFlags 稀疏 draftIndex 更新', () => {
    const drafts = [{ shouldSave: true }, { shouldSave: true }]
    mergeUpdateDraftFlags(drafts, [{ draftIndex: 1, shouldSave: false }])
    expect(drafts[0].shouldSave).toBe(true)
    expect(drafts[1].shouldSave).toBe(false)
  })
})
