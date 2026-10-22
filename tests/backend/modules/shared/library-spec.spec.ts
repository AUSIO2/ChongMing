// 092 先行规格测试：库材料绑定影响复用身份，完整材料不复制进每个 Operation。
import { describe, expect, it } from 'vitest'

import { definitionsDigest, definitionsFreezeExecution, type DefinitionsFreezeInput } from '../../../../backend/modules/shared/data-definition'
import { LIBRARY_TEST_AGENT, LIBRARY_TEST_TRANSITION, LIBRARY_TEST_TYPE, libraryTestCatalog, libraryTestFrozenClaim } from '../../fixtures/library-claims'
import { evidenceParseNodeSnapshot } from '../../../../backend/modules/evidence-library/evidence-record'

function freezeInput(): DefinitionsFreezeInput {
  // 普通本图输入保持既有协议，新增库材料只是独立执行依赖。
  return { catalog: libraryTestCatalog(), transitionRef: LIBRARY_TEST_TRANSITION, agents: [LIBRARY_TEST_AGENT], tools: [],
    inputs: { claim: [{ id: 'target-claim', revision: 3, type: LIBRARY_TEST_TYPE }] }, context: {} }
}

describe('092 selected library claims bind execution identity', () => {
  it('retains manual creation provenance in fixed node snapshots without backfilling historical data', () => {
    // 固定证据节点重读不能丢失创建来源，也不能给旧快照补造人工身份。
    const original = libraryTestFrozenClaim().entry.claim.nodeSnapshot, manualOrigin = { userId: 'original-creator' }
    expect(evidenceParseNodeSnapshot({ ...original, manualOrigin })).toHaveProperty('manualOrigin', manualOrigin)
    expect(evidenceParseNodeSnapshot(original)).not.toHaveProperty('manualOrigin')
    expect(() => evidenceParseNodeSnapshot({ ...original, manualOrigin: { userId: '' } })).toThrow()
  })

  // 只比较真实规格冻结结果，不实现库规则或内存参考模型。
  it('changes specHash for a different selected set without copying full entry text into the spec', () => {
    // 同目标输入选择不同库条目应禁止错复用，完整条目只保存于 Run 步骤集合。
    const a = libraryTestFrozenClaim(), b = libraryTestFrozenClaim()
    const plain = definitionsFreezeExecution(freezeInput())
    const first = definitionsFreezeExecution({ ...freezeInput(), libraryClaims: [a] })
    const other = definitionsFreezeExecution({ ...freezeInput(), libraryClaims: [b] })
    expect(first.libraryClaimRefs).toEqual([a.ref])
    expect(first.specHash).not.toBe(plain.specHash)
    expect(first.specHash).not.toBe(other.specHash)
    expect(JSON.stringify(first)).not.toContain(a.entry.claim.nodeSnapshot.payload.content)
    expect(first.definitionDigests).toContain(definitionsDigest(a.definition))
  })

  it('sorts the selected dependency set and ignores later management status in specHash', () => {
    // UI 选择顺序和撤回管理状态不能改变同一份已冻结执行身份。
    const a = libraryTestFrozenClaim(), b = libraryTestFrozenClaim()
    const first = definitionsFreezeExecution({ ...freezeInput(), libraryClaims: [b, a] })
    const second = definitionsFreezeExecution({ ...freezeInput(), libraryClaims: [a, b] })
    expect(first.specHash).toBe(second.specHash)
    expect(first.libraryClaimRefs).toEqual(second.libraryClaimRefs)
    const withdrawn = structuredClone(a)
    withdrawn.entry.status = 'withdrawn'
    withdrawn.entry.statusReason = '启动后的管理状态变化'
    withdrawn.entry.revision = 2
    expect(definitionsFreezeExecution({ ...freezeInput(), libraryClaims: [withdrawn, b] }).specHash).toBe(first.specHash)
  })

  it('binds the selected Claim definition and preserves empty-set legacy spec shape', () => {
    // 精确投影定义是执行依赖；没有库材料时规格字段及旧hash算法保持兼容。
    const a = libraryTestFrozenClaim()
    const selected = definitionsFreezeExecution({ ...freezeInput(), libraryClaims: [a] })
    const changed = structuredClone(a)
    changed.definition.agentProjection.include = ['/content']
    expect(definitionsFreezeExecution({ ...freezeInput(), libraryClaims: [changed] }).specHash).not.toBe(selected.specHash)
    const plain = definitionsFreezeExecution(freezeInput())
    const empty = definitionsFreezeExecution({ ...freezeInput(), libraryClaims: [] })
    expect(empty).toEqual(plain)
    expect(empty).not.toHaveProperty('libraryClaimRefs')
  })
})
