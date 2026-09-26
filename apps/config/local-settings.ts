import { RuntimeMessage, messageFormat } from '../../contracts/messages'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { inputReadObject, inputReadString } from '../../backend/modules/shared/input-validation'
import { GraphError } from '../../backend/modules/shared/domain-error'

export interface LocalSettings { mongoUri?: string; dataApiUrl?: string; dshHome?: string }
const secretNames = new Set(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY', 'CHONGMING_DATA_TOKEN', 'CHONGMING_AMQP_URL'])

// 用途：读取目录，并把结构化结果交给调用方。
function localReadDirectory(): string { return path.resolve(process.env.CHONGMING_CONFIG_DIR ?? '.chongming-host') }

// 用途：读取文件，并把结构化结果交给调用方。
async function localReadFile(name: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(path.join(localReadDirectory(), name), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(messageFormat(RuntimeMessage.INVALID_LOCAL_CONFIGURATION_VALUE, name))
  }
}

// 用途：处理本机服务相关工作，并把结果交给调用方。
async function localWriteFile(name: string, value: unknown): Promise<void> {
  const directory = localReadDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path.join(directory, name))
}

// 用途：执行本机服务流程，并返回执行结果。
async function localRunWrite<T>(write: () => Promise<T>): Promise<T> {
  const directory = localReadDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lockPath = path.join(directory, 'configuration.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new GraphError(409, 'LOCAL_SETTINGS_BUSY', RuntimeMessage.ANOTHER_LOCAL_CONFIGURATION_WRITE_IS_ACTIVE_RETRY_AFTER_IT_FINISHES)
    throw error
  })
  try { return await write() }
  finally { await lock.close(); await unlink(lockPath) }
}

// 用途：读取配置，并把结构化结果交给调用方。
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

// 用途：更新密钥，并保持相关状态一致。
export async function localUpdateSecret(name: string, value: string | null): Promise<{ configured: boolean }> {
  if (!secretNames.has(name)) throw new Error(RuntimeMessage.UNKNOWN_HOST_SECRET_NAME)
  return localRunWrite(async () => {
    const { secrets } = await localReadConfiguration()
    if (value === null) delete secrets[name]
    else secrets[name] = inputReadString(value, 'value')
    await localWriteFile('secrets.json', secrets)
    return { configured: value !== null }
  })
}

// 用途：更新设置，并保持相关状态一致。
export async function localUpdateSettings(settings: LocalSettings): Promise<void> {
  inputReadObject(settings, ['mongoUri', 'dataApiUrl', 'dshHome'], 'settings')
  for (const [key, value] of Object.entries(settings)) inputReadString(value, key)
  await localRunWrite(() => localWriteFile('settings.json', settings))
}
