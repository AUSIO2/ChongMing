// 读写本机配置与密钥文件，通过独占锁串行化更新并以临时文件替换内容。
import { RuntimeMessage, messageFormat } from '../../contracts/messages'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { inputReadObject, inputReadString } from '../../backend/modules/shared/input-validation'
import { GraphError } from '../../backend/modules/shared/domain-error'

// 不含密钥的本机路径及服务地址设置；密钥存放于独立文件。
export interface LocalSettings { mongoUri?: string; dataApiUrl?: string; dshHome?: string }
const secretNames = new Set(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY', 'CHONGMING_DATA_TOKEN', 'CHONGMING_AMQP_URL'])

function localReadDirectory(): string {
  // 解析本机配置目录，优先使用环境变量指定的位置。
   return path.resolve(process.env.CHONGMING_CONFIG_DIR ?? '.chongming-host') }

/**
 * 读取配置 JSON；文件不存在视为空配置，其他读取或解析失败报告配置错误。
 *
 * @param name 配置目录内由程序选定的 JSON 文件名。
 */
async function localReadFile(name: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(path.join(localReadDirectory(), name), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(messageFormat(RuntimeMessage.INVALID_LOCAL_CONFIGURATION_VALUE, name))
  }
}

/**
 * 将配置写入仅当前用户可读的临时文件，再重命名替换目标文件。
 *
 * @param name 配置目录内由程序选定的目标文件名，临时文件与其同目录。
 * @param value 需要整体序列化保存的配置值，不在此函数做业务校验。
 */
async function localWriteFile(name: string, value: unknown): Promise<void> {
  const directory = localReadDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path.join(directory, name))
}

/**
 * 获取独占配置锁后执行更新，无论成功失败都关闭锁文件并删除锁。
 *
 * @param write 拿到独占锁后执行的异步更新，由本函数负责最终释放锁。
 */
async function localRunWrite<T>(write: () => Promise<T>): Promise<T> {
  const directory = localReadDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lockPath = path.join(directory, 'configuration.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    // 把已存在的锁转换为可识别的并发写入冲突，保留其他文件系统错误。
    if (error.code === 'EEXIST') throw new GraphError(409, 'LOCAL_SETTINGS_BUSY', RuntimeMessage.ANOTHER_LOCAL_CONFIGURATION_WRITE_IS_ACTIVE_RETRY_AFTER_IT_FINISHES)
    throw error
  })
  try { return await write() }
  finally { await lock.close(); await unlink(lockPath) }
}

export async function localReadConfiguration(): Promise<{ settings: LocalSettings; secrets: Record<string, string> }> {
  // 读取并校验设置和密钥的允许字段，返回配置与字符串密钥。
  const values = inputReadObject(await localReadFile('settings.json'), ['mongoUri', 'dataApiUrl', 'dshHome'], 'settings')
  const settings: LocalSettings = {}
  for (const key of ['mongoUri', 'dataApiUrl', 'dshHome'] as const) {
    if (values[key] !== undefined) settings[key] = inputReadString(values[key], key)
  }
  const raw = inputReadObject(await localReadFile('secrets.json'), [...secretNames], 'secrets')
  const secrets = Object.fromEntries(Object.entries(raw).map(([key, value]) => /* 逐项校验密钥值为字符串后重建密钥字典。 */  [key, inputReadString(value, key)]))
  return { settings, secrets }
}

/**
 * 在允许的密钥名称范围内更新或删除单个密钥，并返回是否已配置。
 *
 * @param name 待设置的密钥名称，必须属于程序允许的环境变量白名单。
 * @param value 密钥原文；null 表示删除，非空字符串校验由输入边界完成。
 */
export async function localUpdateSecret(name: string, value: string | null): Promise<{ configured: boolean }> {
  if (!secretNames.has(name)) throw new Error(RuntimeMessage.UNKNOWN_HOST_SECRET_NAME)
  return localRunWrite(async () => {
    // 持锁重读最新密钥集合，应用单项修改后整体写回，避免覆盖并发更新。
    const { secrets } = await localReadConfiguration()
    if (value === null) delete secrets[name]
    else secrets[name] = inputReadString(value, 'value')
    await localWriteFile('secrets.json', secrets)
    return { configured: value !== null }
  })
}

/**
 * 校验完整设置对象后持锁替换设置文件。
 *
 * @param settings 替换整个设置文件的配置对象，先检查允许字段及字符串值。
 */
export async function localUpdateSettings(settings: LocalSettings): Promise<void> {
  inputReadObject(settings, ['mongoUri', 'dataApiUrl', 'dshHome'], 'settings')
  for (const [key, value] of Object.entries(settings)) inputReadString(value, key)
  await localRunWrite(() => /* 在配置锁内写入已校验的设置对象。 */  localWriteFile('settings.json', settings))
}
