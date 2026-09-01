import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  mapDocumentInsert,
  mapDocumentList,
  mapDocumentRead,
} from '../mapper/document'
import type { MapperDocument } from '../mapper/types'
import * as workspaceService from './workspace-service'
import type { AgentDoc } from '../shared/types'

export interface ChongmingMapExportBundle {
  format: 'chongming-map'
  version: 2
  exportedAt: string
  map: MapperDocument
}

interface ChongmingWorkspaceExportBundle {
  format: 'chongming-workspace'
  version: 2
  exportedAt: string
  workspace: {
    name: string
    description?: string
    agents: AgentDoc[]
    ui?: { currentMapId?: string; openMapIds?: string[] }
  }
  maps: MapperDocument[]
}

export function fileReadExportBundle(map: MapperDocument): ChongmingMapExportBundle {
  return {
    format: 'chongming-map',
    version: 2,
    exportedAt: new Date().toISOString(),
    map,
  }
}

export async function fileExportMap(
  getWindow: () => BrowserWindow | null,
  mapId: string,
): Promise<{ ok: boolean; path?: string; cancelled?: boolean }> {
  const map = await mapDocumentRead(mapId)
  if (!map) return { ok: false }
  const options = {
    title: '导出图文件',
    defaultPath: `${map.name?.trim() || mapId}.chongming-map.json`,
    filters: [{ name: 'Chongming Map', extensions: ['json'] }],
  }
  const win = getWindow()
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
  writeFileSync(
    result.filePath,
    JSON.stringify(fileReadExportBundle(map), null, 2),
    'utf-8',
  )
  return { ok: true, path: result.filePath }
}

export async function fileExportWorkspace(
  getWindow: () => BrowserWindow | null,
  workspaceId: string,
): Promise<{ ok: boolean; path?: string; cancelled?: boolean }> {
  const workspace = await workspaceService.workspaceGet(workspaceId)
  if (!workspace) return { ok: false }
  const summaries = await mapDocumentList(workspaceId)
  const maps = (await Promise.all(
    summaries.map(summary => mapDocumentRead(summary.id)),
  )).filter((map): map is MapperDocument => map !== null)
  const bundle: ChongmingWorkspaceExportBundle = {
    format: 'chongming-workspace',
    version: 2,
    exportedAt: new Date().toISOString(),
    workspace: {
      name: workspace.name,
      description: workspace.description,
      agents: workspace.agents,
      ui: workspace.ui,
    },
    maps,
  }
  const options = {
    title: '导出工作区',
    defaultPath: `${workspace.name.trim() || workspaceId}.chongming-workspace.json`,
    filters: [{ name: 'Chongming Workspace', extensions: ['json'] }],
  }
  const win = getWindow()
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
  writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf-8')
  return { ok: true, path: result.filePath }
}

export async function fileImportWorkspace(
  getWindow: () => BrowserWindow | null,
): Promise<{ ok: boolean; workspaceId?: string; cancelled?: boolean; error?: string }> {
  const options = {
    title: '导入工作区',
    filters: [{ name: 'Chongming Workspace', extensions: ['json'] }],
    properties: ['openFile' as const],
  }
  const win = getWindow()
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true }

  try {
    const bundle = JSON.parse(
      readFileSync(result.filePaths[0], 'utf-8'),
    ) as ChongmingWorkspaceExportBundle
    if (
      bundle.format !== 'chongming-workspace'
      || bundle.version !== 2
      || !bundle.workspace
    ) return { ok: false, error: '无效的工作区文件' }

    const workspace = await workspaceService.workspaceCreate({
      name: bundle.workspace.name || '导入的工作区',
      description: bundle.workspace.description,
      agents: bundle.workspace.agents ?? [],
    })
    for (const map of bundle.maps ?? []) {
      await mapDocumentInsert(map, workspace._id)
    }
    if (bundle.workspace.ui) {
      await workspaceService.workspaceUpdate(workspace._id, {
        ui: bundle.workspace.ui,
      })
    }
    return { ok: true, workspaceId: workspace._id }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
