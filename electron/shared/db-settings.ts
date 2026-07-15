import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathsReadSettingsDir } from './paths'

export interface DbSettings {
  uri: string
}

const DEFAULT_URI = process.env.MONGO_URI ?? 'mongodb://localhost:27017/chongming'

function dbReadSettingsPath(): string {
  const dir = pathsReadSettingsDir()
  mkdirSync(dir, { recursive: true })
  return path.join(dir, 'db-settings.json')
}

export function dbReadSettings(): DbSettings {
  const file = dbReadSettingsPath()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { uri?: unknown }
    if (typeof raw.uri === 'string' && raw.uri.trim()) {
      return { uri: raw.uri.trim() }
    }
  } catch {
    /* use default */
  }
  return { uri: DEFAULT_URI }
}

export function dbWriteSettings(settings: DbSettings): void {
  writeFileSync(dbReadSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

export function dbReadDefaultUri(): string {
  return DEFAULT_URI
}
