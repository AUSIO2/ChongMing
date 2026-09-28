// 持久化桌面远程连接地址，并仅在可信系统密钥后端可用时保存加密令牌。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { clientReadBaseUrl, type ClientConnectionStore } from '../../client/graph-client'
import type { ClientConnectInput } from '../../contracts/client'

// 对系统凭据加解密能力的最小依赖，允许测试替换具体平台实现。
export interface ClientSafeStorage {
  // 报告系统是否提供可用的加密能力；调用方仍需核对 Linux 后端。
  isEncryptionAvailable(): boolean
  // 使用系统密钥服务加密字符串，结果由调用方编码后持久化。
  encryptString(/* 需要交给系统密钥服务加密的令牌原文。 */ value: string): Buffer
  // 解密已保存的系统密文；密钥不可用时允许抛错，由存储层降级为未记住。
  decryptString(/* 此前由系统密钥服务加密并从文件恢复的密文字节。 */ value: Buffer): string
  // 返回 Linux 当前密钥后端名称，供调用方排除明文后端。
  getSelectedStorageBackend?(): string
}
export function clientCreateStorage(/* 凭据文件目录、系统加密能力与可选平台覆盖；省略平台时使用当前系统。 */ input: { directory: string; secure: ClientSafeStorage; platform?: NodeJS.Platform }): ClientConnectionStore {
  // 创建远程连接存储，用系统密钥服务保护令牌并通过临时文件原子替换配置。
  const filename = path.join(input.directory, 'client-connection.json')
  function clientReadStoragePermission(): boolean {
    // 检查系统加密可用性，并在 Linux 上排除不具备可信密钥后端的存储方式。
    if (!input.secure.isEncryptionAvailable()) return false
    return (input.platform ?? process.platform) !== 'linux'
      || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(input.secure.getSelectedStorageBackend?.() ?? 'unknown')
  }
  return {
    canRemember: clientReadStoragePermission,
    async load() {
      // 恢复连接地址并尝试解密令牌；未授权记住或解密失败时只返回地址。
      try {
        const value = JSON.parse(await readFile(filename, 'utf8'))
        if (value.version !== 1 || typeof value.baseUrl !== 'string') return null
        const baseUrl = clientReadBaseUrl(value.baseUrl)
        if (typeof value.encryptedToken !== 'string' || !clientReadStoragePermission()) return { baseUrl, token: null, remembered: false }
        try {
          const token = input.secure.decryptString(Buffer.from(value.encryptedToken, 'base64'))
          return { baseUrl, token, remembered: !!token }
        } catch { return { baseUrl, token: null, remembered: false } }
      } catch (error) {
        if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return null
        throw error
      }
    },
    async save(/* 待保存的远程连接选项；remember 仅表达意愿，还需通过系统加密能力检查。 */ value: ClientConnectInput): Promise<boolean> {
      // 保存规范化地址，仅在用户要求且加密后端可信时写入令牌密文，返回实际记住状态。
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
    async clear(): Promise<void> {
      // 删除已保存连接文件，文件不存在时保持成功。
       await rm(filename, { force: true }) },
  }
}
