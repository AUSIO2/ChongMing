import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { clientReadBaseUrl, type ClientConnectionStore } from '../client/api'
import type { ClientConnectInput } from '../contracts/client'

export interface ClientSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}
export function clientCreateStorage(input: { directory: string; secure: ClientSafeStorage; platform?: NodeJS.Platform }): ClientConnectionStore {
  const filename = path.join(input.directory, 'client-connection.json')
  function clientReadStoragePermission(): boolean {
    if (!input.secure.isEncryptionAvailable()) return false
    return (input.platform ?? process.platform) !== 'linux'
      || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(input.secure.getSelectedStorageBackend?.() ?? 'unknown')
  }
  return {
    canRemember: clientReadStoragePermission,
    async load() {
      try {
        const value = JSON.parse(await readFile(filename, 'utf8'))
        if (value.version !== 1 || typeof value.baseUrl !== 'string') return null
        const baseUrl = clientReadBaseUrl(value.baseUrl)
        if (typeof value.encryptedToken !== 'string' || !clientReadStoragePermission()) return { baseUrl, token: null, remembered: false }
        try {
          const token = input.secure.decryptString(Buffer.from(value.encryptedToken, 'base64'))
          return { baseUrl, token, remembered: !!token }
        } catch { return { baseUrl, token: null, remembered: false } }
      } catch { return null }
    },
    async save(value: ClientConnectInput): Promise<boolean> {
      const remembered = value.remember && clientReadStoragePermission()
      const document = {
        version: 1,
        baseUrl: clientReadBaseUrl(value.baseUrl),
        ...(remembered ? { encryptedToken: input.secure.encryptString(value.token.trim()).toString('base64') } : {}),
      }
      await mkdir(input.directory, { recursive: true })
      const temporary = filename + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, JSON.stringify(document), { mode: 0o600 })
        await rename(temporary, filename)
      } finally { await rm(temporary, { force: true }) }
      return remembered
    },
    async clear(): Promise<void> { await rm(filename, { force: true }) },
  }
}
