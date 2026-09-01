import { describe, expect, it } from 'vitest'
import { fileReadExportBundle } from '../../electron/api/file-service'
import type { MapperDocument } from '../../electron/mapper/types'

function sampleMap(): MapperDocument {
  return {
    id: 'map-1',
    workspaceId: 'workspace:default',
    name: '测试图',
    sources: [],
    news: [],
    claims: [],
    routes: [],
    timeline: { startX: 0, endX: 1, activeScope: 'news:default' },
    revision: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('fileReadExportBundle', () => {
  it('生成 chongming-map v2 导出包', () => {
    const map = sampleMap()
    const bundle = fileReadExportBundle(map)
    expect(bundle.format).toBe('chongming-map')
    expect(bundle.version).toBe(2)
    expect(bundle.map).toBe(map)
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
