// 模型Key使用独立主密钥加密；主密钥只由部署入口读取，不进入业务库或公开合同。
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ModelSecretCodec } from '../../ports/model-secrets'

enum ModelSecretMessage {
  INVALID_MASTER_KEY = '模型加密主密钥无效，请恢复原主密钥文件。',
  INVALID_CIPHERTEXT = '模型密钥密文无法验证，请重新配置该 API Key。',
}
const associatedData = Buffer.from('chongming.model-key.v1')

export function modelCreateSecretCodec(
  /* 仅当前部署持有的32字节主密钥，不接受用户API Key充当主密钥。 */ key: Uint8Array,
): ModelSecretCodec {
  // 每次加密使用独立随机IV和认证标签，损坏数据不能被当作明文继续使用。
  if (key.byteLength !== 32) throw new Error(ModelSecretMessage.INVALID_MASTER_KEY)
  const master = Buffer.from(key)
  return {
    seal(/* 本次工作区或Agent提交的原始Key。 */ value) {
      // 只返回版本化密文，任何配置视图均不应包含这个值。
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv)
      cipher.setAAD(associatedData)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(':')
    },
    open(/* 仅从私有连接记录读取的已保存密文。 */ value) {
      // 无效版本、编码、标签或主密钥统一拒绝，不将密文或底层错误写到日志。
      try {
        const parts = value.split(':')
        if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error()
        const iv = Buffer.from(parts[1], 'base64url'), encrypted = Buffer.from(parts[2], 'base64url'), tag = Buffer.from(parts[3], 'base64url')
        if (iv.length !== 12 || tag.length !== 16) throw new Error()
        const decipher = createDecipheriv('aes-256-gcm', master, iv)
        decipher.setAAD(associatedData); decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
      } catch { throw new Error(ModelSecretMessage.INVALID_CIPHERTEXT) }
    },
  }
}

export async function modelLoadSecretCodec(
  /* 由部署入口指定的持久配置目录，每个部署/本地数据库各自持有。 */ directory: string,
): Promise<ModelSecretCodec> {
  // 先完整写入私有临时文件，再以独占硬链接发布；并发初始化只会采用同一份完整主密钥。
  const filename = path.join(directory, 'model-encryption.key')
  try { return modelCreateSecretCodec(await readFile(filename)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = filename + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 })
  try {
    try { await link(temporary, filename) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  } finally { await unlink(temporary) }
  return modelCreateSecretCodec(await readFile(filename))
}
