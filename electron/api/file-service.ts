import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import * as mapService from './map-service'
import type { DisplayMap } from './types'

export interface ChongmingMapExportBundle {
  format: 'chongming-map'
  version: 1
  exportedAt: string
  map: DisplayMap
}

export function fileReadExportBundle(map: DisplayMap): ChongmingMapExportBundle {
  return {
    format: 'chongming-map',
    version: 1,
    exportedAt: new Date().toISOString(),
    map,
  }
}

export async function fileExportMap(
  getWindow: () => BrowserWindow | null,
  mapId: string,
): Promise<{ ok: boolean, path?: string, cancelled?: boolean }> {
  const map = await mapService.mapRead(mapId)
  if (!map) return { ok: false }

  const win = getWindow()
  const result = await dialog.showSaveDialog(win ?? undefined, {
    title: '导出图文件',
    defaultPath: `${map.name?.trim() || mapId}.chongming-map.json`,
    filters: [{ name: 'Chongming Map', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) {
    return { ok: false, cancelled: true }
  }

  const bundle = fileReadExportBundle(map)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf-8')
  return { ok: true, path: result.filePath }
}
