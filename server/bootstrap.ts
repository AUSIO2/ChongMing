import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../electron/shared/load-env'
import { pathsUpdateDataDir } from '../electron/shared/paths'
import { dbCreate, dbDelete } from '../electron/shared/database'
import { dbReadSettings } from '../electron/shared/db-settings'
import { clientReadId } from '../electron/shared/client-identity'
import { promptUpdateConfigRoot } from '../electron/shared/prompt-loader'
import { mapLeaseReleaseAllHeld } from '../electron/api/map-lease'
import { workspaceBootstrapAfterConnect } from '../electron/api/workspace-service'
import { mapperService } from '../electron/mapper'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

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
}

export async function serverShutdown(): Promise<void> {
  try {
    await mapperService.close()
    await mapLeaseReleaseAllHeld()
  } finally {
    await dbDelete()
  }
}
