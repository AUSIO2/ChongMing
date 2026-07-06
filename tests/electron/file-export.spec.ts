import { describe, expect, it } from 'vitest'
import { fileReadExportBundle } from '../../electron/api/file-service'
import type { DisplayMap } from '../../electron/api/types'

function sampleMap(): DisplayMap {
  return {
    _id: 'map-1',
    name: '测试图',
    content: '正文',
    context: { newsId: 'n1', title: '标题', source: 'src' },
    claims: [],
    timeline: { startX: 0, endX: 1, activeScope: 'news:default' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('fileReadExportBundle', () => {
  it('生成 chongming-map v1 导出包', () => {
    const map = sampleMap()
    const bundle = fileReadExportBundle(map)
    expect(bundle.format).toBe('chongming-map')
    expect(bundle.version).toBe(1)
    expect(bundle.map).toBe(map)
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
