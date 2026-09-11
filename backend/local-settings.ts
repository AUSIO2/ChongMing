import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mongo } from 'mongoose'
import { inputReadObject, inputReadString } from './input'
import { GraphError } from './graph-error'

export interface LocalSettings { mongoUri?: string; dataApiUrl?: string; dshHome?: string }
const secretNames = new Set(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY', 'CHONGMING_DATA_TOKEN'])

function localReadDirectory(): string { return path.resolve(process.env.CHONGMING_CONFIG_DIR ?? '.chongming-host') }

async function localReadFile(name: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(path.join(localReadDirectory(), name), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Invalid local configuration: ${name}`)
  }
}

async function localWriteFile(name: string, value: unknown): Promise<void> {
  const directory = localReadDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path.join(directory, name))
}

async function localRunWrite<T>(write: () => Promise<T>): Promise<T> {
  const directory = localReadDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lockPath = path.join(directory, 'configuration.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new GraphError(409, 'LOCAL_SETTINGS_BUSY', 'Another local configuration write is active; retry after it finishes')
    throw error
  })
  try { return await write() }
  finally { await lock.close(); await unlink(lockPath) }
}

export async function localReadConfiguration(): Promise<{ settings: LocalSettings; secrets: Record<string, string> }> {
  const values = inputReadObject(await localReadFile('settings.json'), ['mongoUri', 'dataApiUrl', 'dshHome'], 'settings')
  const settings: LocalSettings = {}
  for (const key of ['mongoUri', 'dataApiUrl', 'dshHome'] as const) {
    if (values[key] !== undefined) settings[key] = inputReadString(values[key], key)
  }
  const raw = inputReadObject(await localReadFile('secrets.json'), [...secretNames], 'secrets')
  const secrets = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, inputReadString(value, key)]))
  return { settings, secrets }
}

export async function localUpdateSecret(name: string, value: string | null): Promise<{ configured: boolean }> {
  if (!secretNames.has(name)) throw new Error('Unknown Host secret name')
  return localRunWrite(async () => {
    const { secrets } = await localReadConfiguration()
    if (value === null) delete secrets[name]
    else secrets[name] = inputReadString(value, 'value')
    await localWriteFile('secrets.json', secrets)
    return { configured: value !== null }
  })
}

export async function localUpdateSettings(settings: LocalSettings): Promise<void> {
  inputReadObject(settings, ['mongoUri', 'dataApiUrl', 'dshHome'], 'settings')
  for (const [key, value] of Object.entries(settings)) inputReadString(value, key)
  await localRunWrite(() => localWriteFile('settings.json', settings))
}

export function localReadUri(uri: string): string {
  try {
    const parsed = new mongo.MongoClient(uri).options
    const scheme = uri.startsWith('mongodb+srv:') ? 'mongodb+srv' : 'mongodb'
    const hosts = parsed.srvHost ?? parsed.hosts.map(host => host.toString()).join(',')
    return `${scheme}://${parsed.credentials ? '***@' : ''}${hosts}/${encodeURIComponent(parsed.dbName)}`
      + (uri.includes('?') ? '?<options-redacted>' : '')
  } catch { return '<invalid Mongo URI>' }
}
