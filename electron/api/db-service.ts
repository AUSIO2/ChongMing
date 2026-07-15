import mongoose from 'mongoose'
import { dbCreate, dbDelete } from '../shared/database'
import { dbReadDefaultUri, dbReadSettings, dbWriteSettings } from '../shared/db-settings'
import { errReadMessage } from '../shared/errors'
import * as mapService from './map-service'
import type { DisplayMapSummary } from './types'

export interface DbStatus {
  uri: string
  connected: boolean
  readyState: number
  databaseName?: string
}

export async function dbGetSettings(): Promise<{ uri: string, defaultUri: string }> {
  const settings = dbReadSettings()
  return { uri: settings.uri, defaultUri: dbReadDefaultUri() }
}

export async function dbSaveSettings(uri: string): Promise<void> {
  dbWriteSettings({ uri: uri.trim() })
}

export async function dbGetStatus(): Promise<DbStatus> {
  const { uri } = dbReadSettings()
  const conn = mongoose.connection
  return {
    uri,
    connected: conn.readyState === 1,
    readyState: conn.readyState,
    databaseName: conn.db?.databaseName,
  }
}

export async function dbTestConnection(uri: string): Promise<{ ok: boolean, error?: string }> {
  const testUri = uri.trim()
  if (!testUri) return { ok: false, error: 'URI 不能为空' }
  if (testUri === 'memory') return { ok: true }

  try {
    const conn = mongoose.createConnection(testUri, {
      serverSelectionTimeoutMS: 4000,
    })
    await conn.asPromise()
    await conn.close()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errReadMessage(error) }
  }
}

async function dbReconnectUri(uri: string): Promise<DisplayMapSummary[]> {
  await dbDelete()
  await dbCreate(uri)
  const { workspaceBootstrapAfterConnect, WORKSPACE_DEFAULT_ID } = await import(
    './workspace-service'
  )
  await workspaceBootstrapAfterConnect()
  return mapService.mapReadIndex(WORKSPACE_DEFAULT_ID)
}

export async function dbReconnect(): Promise<DisplayMapSummary[]> {
  const { uri } = dbReadSettings()
  return dbReconnectUri(uri)
}

export async function dbSwitch(uri: string): Promise<DisplayMapSummary[]> {
  const next = uri.trim()
  dbWriteSettings({ uri: next })
  return dbReconnectUri(next)
}
