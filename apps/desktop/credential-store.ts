// 持久化桌面远程连接地址，只在可信系统密钥后端可用时保存加密刷新凭据。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { clientReadBaseUrl, type ClientConnectionStore } from '../../client/graph-client'

// 对系统凭据加解密能力的最小依赖，允许测试替换具体平台实现。
export interface ClientSafeStorage {
  // 报告系统是否提供可用的加密能力；调用方仍需核对 Linux 后端。
  isEncryptionAvailable(): boolean
  /**
   * 使用系统密钥服务加密字符串，结果由调用方编码后持久化。
   *
   * @param value 需要交给系统密钥服务加密的令牌原文。
   */
  encryptString(value: string): Buffer
  /**
   * 解密已保存的系统密文；密钥不可用时允许抛错，由存储层降级为未记住。
   *
   * @param value 此前由系统密钥服务加密并从文件恢复的密文字节。
   */
  decryptString(value: Buffer): string
  // 返回 Linux 当前密钥后端名称，供调用方排除明文后端。
  getSelectedStorageBackend(): string
}
/**
 * 创建远程连接存储，用系统密钥服务保护令牌并通过临时文件原子替换配置。
 *
 * @param input 凭据文件目录、系统加密能力与可选平台覆盖；省略平台时使用当前系统。
 */
export function clientCreateStorage(input: { directory: string; secure: ClientSafeStorage; platform?: NodeJS.Platform }): ClientConnectionStore {
  const filename = path.join(input.directory, 'client-connection.json')
  function clientReadStoragePermission(): boolean {
    // 检查系统加密可用性，并在 Linux 上排除不具备可信密钥后端的存储方式。
    if (!input.secure.isEncryptionAvailable()) return false
    return (input.platform ?? process.platform) !== 'linux'
      || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(input.secure.getSelectedStorageBackend())
  }
  async function clientWriteDocument(
    /* 本机只允许保存规范化服务地址及可选刷新密文。 */ document: { version: 2; baseUrl: string; encryptedRefreshToken?: string },
  ): Promise<void> {
    // v1迁移和正常保存使用相同原子替换与受限文件权限。
    await mkdir(input.directory, { recursive: true })
    const temporary = filename + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify(document), { mode: 0o600 })
      await rename(temporary, filename)
    } finally { await rm(temporary, { force: true }) }
  }
  return {
    canRemember: clientReadStoragePermission,
    async load() {
      // 恢复连接地址及v2刷新密文；旧访问令牌迁移、解密失败时只返回地址。
      try {
        const bytes = await readFile(filename)
        let value: unknown
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) }
        catch { return null }
        if (!value || typeof value !== 'object' || !('version' in value) || (value.version !== 1 && value.version !== 2)
          || !('baseUrl' in value) || typeof value.baseUrl !== 'string') return null
        const baseUrl = clientReadBaseUrl(value.baseUrl)
        if (value.version === 1) {
          // 旧访问令牌不当作刷新令牌恢复，迁移时只保留地址并删除旧密文。
          await clientWriteDocument({ version: 2, baseUrl })
          return { baseUrl, refreshToken: null, remembered: false }
        }
        if (!('encryptedRefreshToken' in value) || typeof value.encryptedRefreshToken !== 'string' || !clientReadStoragePermission()) return { baseUrl, refreshToken: null, remembered: false }
        try {
          const refreshToken = input.secure.decryptString(Buffer.from(value.encryptedRefreshToken, 'base64'))
          return { baseUrl, refreshToken: refreshToken || null, remembered: !!refreshToken }
        } catch { return { baseUrl, refreshToken: null, remembered: false } }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        throw error
      }
    },
    /**
     * 保存规范化地址，仅在用户要求且加密后端可信时写入刷新密文，返回实际记住状态。
     *
     * @param value 待保存的远程连接选项；remember 仅表达意愿，还需通过系统加密能力检查。
     */
    async save(/* 账户刷新凭据或仅含地址的手工令牌连接设置。 */ value: Parameters<ClientConnectionStore['save']>[0]): Promise<boolean> {
      const remembered = value.remember && !!value.refreshToken?.trim() && clientReadStoragePermission()
      const document = {
        version: 2 as const,
        baseUrl: clientReadBaseUrl(value.baseUrl),
        ...(remembered && value.refreshToken ? { encryptedRefreshToken: input.secure.encryptString(value.refreshToken.trim()).toString('base64') } : {}),
      }
      await clientWriteDocument(document)
      return remembered
    },
    async clear(): Promise<void> {
      // 删除已保存连接文件，文件不存在时保持成功。
       await rm(filename, { force: true }) },
  }
}
