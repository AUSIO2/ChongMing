import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../electron/shared/load-env'
import { pathsUpdateDataDir } from '../electron/shared/paths'
import { dbCreate, dbDelete } from '../electron/shared/database'
import { dbReadSettings } from '../electron/shared/db-settings'
import { clientReadId } from '../electron/shared/client-identity'
import { ckptCreate } from '../electron/shared/checkpointer'
import { promptUpdateConfigRoot } from '../electron/shared/prompt-loader'
import { mapLeaseReleaseAllHeld } from '../electron/api/map-lease'
import { apiBuildInprocess } from '../electron/api/inprocess-api'
import type { ElectronAPI } from '../electron/api/types'
import { workspaceBootstrapAfterConnect } from '../electron/api/workspace-service'
import { adapterBuildIpc } from '../src/flow-map/adapters/electron-ipc'
import { portRegisterApi } from '../src/flow-map/port'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

let installedElectron: ElectronAPI | null = null

export function serverReadElectronApi(): ElectronAPI {
  if (!installedElectron) {
    throw new Error('server not bootstrapped')
  }
  return installedElectron
}

export interface ServerBootstrapOpts {
  appRoot?: string
  dataDir?: string
  mongoUri?: string
}

export async function serverBootstrap(opts: ServerBootstrapOpts = {}): Promise<void> {
  const appRoot = opts.appRoot
    ?? process.env.APP_ROOT
    ?? path.join(moduleDir, '..')
  process.env.APP_ROOT = appRoot

  if (opts.dataDir) {
    pathsUpdateDataDir(opts.dataDir)
  } else if (process.env.CHONGMING_DATA_DIR?.trim()) {
    pathsUpdateDataDir(process.env.CHONGMING_DATA_DIR.trim())
  }

  loadEnv(appRoot)
  promptUpdateConfigRoot(path.join(appRoot, 'subagentconfig'))
  clientReadId()

  const uri = opts.mongoUri ?? dbReadSettings().uri
  await dbCreate(uri)
  await workspaceBootstrapAfterConnect()
  await ckptCreate()

  installedElectron = apiBuildInprocess()
  portRegisterApi(adapterBuildIpc(installedElectron))
}

export async function serverShutdown(): Promise<void> {
  installedElectron = null
  try {
    await mapLeaseReleaseAllHeld()
  } finally {
    await dbDelete()
  }
}
