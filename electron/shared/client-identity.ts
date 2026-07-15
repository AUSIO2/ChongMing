import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathsReadSettingsDir } from './paths'

interface ClientIdentityFile {
  clientId?: string
}

let cachedClientId: string | null = null
/** 测试注入；非空时覆盖磁盘身份 */
let testClientId: string | null = null

function clientReadPath(): string {
  const dir = pathsReadSettingsDir()
  mkdirSync(dir, { recursive: true })
  return path.join(dir, 'client-identity.json')
}

function clientReadFile(): ClientIdentityFile {
  try {
    return JSON.parse(readFileSync(clientReadPath(), 'utf-8')) as ClientIdentityFile
  } catch {
    return {}
  }
}

function clientWriteFile(file: ClientIdentityFile): void {
  writeFileSync(clientReadPath(), `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
}

/** 读取或创建持久 clientId（本机安装身份）。 */
export function clientReadId(): string {
  if (testClientId) return testClientId
  if (cachedClientId) return cachedClientId

  const file = clientReadFile()
  const existing = file.clientId?.trim()
  if (existing) {
    cachedClientId = existing
    return existing
  }

  const next = randomUUID()
  clientWriteFile({ clientId: next })
  cachedClientId = next
  return next
}

/** 测试用：固定 holder，避免依赖 Electron userData。 */
export function clientSetIdForTest(id: string | null): void {
  testClientId = id
  cachedClientId = null
}
