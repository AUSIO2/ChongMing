import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { MapModel } from '../shared/database'
import * as mapService from './map-service'
import * as workspaceService from './workspace-service'
import { serialReadMap } from './serialize'
import { MAP_DEFAULT_SCOPE } from '../shared/map-scope'
import type {
  ChongMingWorkspaceBundle,
  DisplayMap,
} from './types'

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
  const result = win
    ? await dialog.showSaveDialog(win, {
      title: '导出图文件',
      defaultPath: `${map.name?.trim() || mapId}.chongming-map.json`,
      filters: [{ name: 'Chongming Map', extensions: ['json'] }],
    })
    : await dialog.showSaveDialog({
      title: '导出图文件',
      defaultPath: `${map.name?.trim() || mapId}.chongming-map.json`,
      filters: [{ name: 'Chongming Map', extensions: ['json'] }],
    })
  if (result.canceled || !result.filePath) {
    return { ok: false, cancelled: true }
  }

  const bundle = fileReadExportBundle(map)
  writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf-8')
  return { ok: true, path: result.filePath }
}

export async function fileExportWorkspace(
  getWindow: () => BrowserWindow | null,
  workspaceId: string,
): Promise<{ ok: boolean, path?: string, cancelled?: boolean }> {
  const workspace = await workspaceService.workspaceGet(workspaceId)
  if (!workspace) return { ok: false }

  const mapDocs = await MapModel.find({ workspaceId }).lean()
  const maps = mapDocs.map(doc => {
    const activeScope = (doc.timeline as { activeScope?: string } | undefined)
      ?.activeScope ?? MAP_DEFAULT_SCOPE
    return serialReadMap(doc, activeScope)
  })

  const bundle: ChongMingWorkspaceBundle = {
    format: 'chongming-workspace',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      _id: workspace._id,
      name: workspace.name,
      description: workspace.description,
      agents: workspace.agents,
      ui: workspace.ui,
    },
    maps,
  }

  const win = getWindow()
  const saveOpts = {
    title: '导出工作区',
    defaultPath: `${workspace.name.trim() || workspaceId}.chongming-workspace.json`,
    filters: [{ name: 'Chongming Workspace', extensions: ['json'] }],
  }
  const result = win
    ? await dialog.showSaveDialog(win, saveOpts)
    : await dialog.showSaveDialog(saveOpts)
  if (result.canceled || !result.filePath) {
    return { ok: false, cancelled: true }
  }

  writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf-8')
  return { ok: true, path: result.filePath }
}

export async function fileImportWorkspace(
  getWindow: () => BrowserWindow | null,
): Promise<{
  ok: boolean
  workspaceId?: string
  cancelled?: boolean
  error?: string
}> {
  const win = getWindow()
  const openOpts = {
    title: '导入工作区',
    filters: [{ name: 'Chongming Workspace', extensions: ['json'] }],
    properties: ['openFile' as const],
  }
  const result = win
    ? await dialog.showOpenDialog(win, openOpts)
    : await dialog.showOpenDialog(openOpts)
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, cancelled: true }
  }

  try {
    const raw = JSON.parse(readFileSync(result.filePaths[0], 'utf-8')) as ChongMingWorkspaceBundle
    if (raw.format !== 'chongming-workspace' || raw.version !== 1 || !raw.workspace) {
      return { ok: false, error: '无效的工作区文件' }
    }

    const created = await workspaceService.workspaceCreate({
      name: raw.workspace.name || '导入的工作区',
      description: raw.workspace.description,
      agents: raw.workspace.agents ?? [],
    })

    for (const map of raw.maps ?? []) {
      await mapService.mapCreate({
        _id: map._id,
        workspaceId: created._id,
        name: map.name,
        content: map.content ?? '',
        context: map.context ?? {},
      })
      if (map.mapGraph || map.mapRun) {
        await mapService.mapUpdatePersistMap(map._id, {
          mapGraph: map.mapGraph ?? null,
          mapRun: map.mapRun ?? null,
        })
      }
    }

    if (raw.workspace.ui) {
      await workspaceService.workspaceUpdate(created._id, { ui: raw.workspace.ui })
    }

    return { ok: true, workspaceId: created._id }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
