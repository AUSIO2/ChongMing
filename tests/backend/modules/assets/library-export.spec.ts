// 092 库引用不属于当前v4数据交换协议；真实导出codec明确拒绝非空引用，不生成不可恢复包。
import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { bundlesReadMapDocument } from '../../../../backend/modules/assets/bundle-codec'
import { libraryTestDocument } from '../../fixtures/library-claims'

describe('current v4 bundle export with library usage metadata', () => {
  // Map/workspace导出均使用此真实投影入口；已有数据文档不因导出改变。
  it('explicitly rejects nonempty library references rather than exporting a v4 bundle that its importer cannot restore', () => {
    // 条目身份与摘要形状有效，不以无效输入触发其他错误代替交换边界。
    const { document } = libraryTestDocument()
    document.nodes[0].libraryClaimRefs = [{ entryId: randomUUID(), contentDigest: 'a'.repeat(64), reason: '真实消费者的明确库使用。' }]
    const before = structuredClone(document)
    expect(() => bundlesReadMapDocument(document)).toThrow(expect.objectContaining({ status: 422, code: 'EVIDENCE_EXCHANGE_UNSUPPORTED' }))
    expect(document).toEqual(before)
  })

  it.each(['omitted', 'explicit empty'] as const)('exports a compatible node when references are %s without mutating its source document', (
    /* 当前源节点没有库引用的两种合法协议形状。 */ shape,
  ) => {
    // v4没有该字段，空引用投影必须省略而非导出旧导入器不认识的空数组。
    const { document } = libraryTestDocument()
    if (shape === 'explicit empty') document.nodes[0].libraryClaimRefs = []
    const before = structuredClone(document)
    const bundleMap = bundlesReadMapDocument(document)
    expect(bundleMap.nodes[0]).not.toHaveProperty('libraryClaimRefs')
    expect(bundleMap.nodes[0].payload).toEqual(document.nodes[0].payload)
    expect(bundleMap.nodes[0]).not.toHaveProperty('payloadReferences')
    expect(document).toEqual(before)
    expect(bundleMap.nodes[0]).not.toBe(document.nodes[0])
  })
})
