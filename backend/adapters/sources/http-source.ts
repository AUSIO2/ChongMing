// 文件职责：安全读取限定媒体类型的 HTTP 来源，固定解析后的目标并限制大小和期限。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { SOURCE_MEDIA_TYPES } from '../../ports/source-reader'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { GraphError } from '../../modules/shared/domain-error'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(address, prefix, 'ipv6')


/** Pin a validated destination; DNS rebinding and redirects cannot reach Host-local services. */
/**
 * 校验无凭据的 HTTP 地址，固定可接受的解析目标，读取至多 1 MiB UTF-8 正文。
 *
 * @param value 待读取的来源 URL，仍需校验协议、凭据和解析地址。
 * @param allowPrivate 仅测试部署可显式启用的私网例外，默认拒绝禁止网段。
 */
export async function sourceReadUrl(value: string, allowPrivate = false): Promise<string> {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new GraphError(422, 'INVALID_SOURCE', RuntimeMessage.SOURCE_URL_MUST_USE_HTTP_S_WITHOUT_CREDENTIALS)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    // 建立覆盖 DNS 与 HTTP 读取的总超时等待。
    timer = setTimeout(() => {
      // 达到期限时取消网络请求并返回来源超时错误。
      controller.abort()
      reject(new GraphError(422, 'SOURCE_UNAVAILABLE', RuntimeMessage.SOURCE_REQUEST_TIMED_OUT))
    }, 10_000)
  })
  const read = async () => {
    // 解析并检查全部目标地址，以首个已验证地址发起不跟随重定向的请求。
    const family = isIP(hostname)
    const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true, verbatim: true })
    controller.signal.throwIfAborted()
    if (!addresses.length || (!allowPrivate && addresses.some(item => /* 判断任一解析地址是否属于禁止访问的网段。 */  blocked.check(item.address, item.family === 6 ? 'ipv6' : 'ipv4')))) {
      throw new GraphError(422, 'SOURCE_ADDRESS_BLOCKED', RuntimeMessage.SOURCE_URL_MUST_RESOLVE_TO_A_PUBLIC_INTERNET_ADDRESS)
    }
    const destination = addresses[0]
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    return new Promise<string>((resolve, reject) => {
      // 启动固定目标的请求，并将响应读取或网络错误传递给调用者。
      const pending = request(url, {
        signal: controller.signal,
        family: destination.family,
        /**
         * 复用已校验的目标地址，阻止连接阶段再次 DNS 解析改变目的地。
         *
         * @param _hostname Node 发起连接时询问的主机名，此处忽略以固定已校验目标。
         * @param options Node 的 lookup 选项，all 决定回调接收单地址还是地址数组。
         * @param callback Node 连接解析回调，只返回此前校验通过的固定目的地址。
         */
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [destination])
          else callback(null, destination.address, destination.family)
        },
        headers: { accept: [...SOURCE_MEDIA_TYPES].join(', ') },
      }, async response => {
        // 验证成功状态和媒体类型，限量读取并严格解码 UTF-8，最后释放响应。
        try {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            throw new GraphError(422, 'SOURCE_UNAVAILABLE', messageFormat(RuntimeMessage.SOURCE_RETURNED_HTTP_VALUE, response.statusCode))
          }
          if (!SOURCE_MEDIA_TYPES.has((response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase())) {
            throw new GraphError(422, 'UNSUPPORTED_MEDIA_TYPE', RuntimeMessage.SOURCE_MUST_BE_UTF_8_TEXT_MARKDOWN_HTML_OR_JSON)
          }
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of response) {
            size += chunk.length
            if (size > 1_048_576) throw new GraphError(413, 'SOURCE_LIMIT', RuntimeMessage.SOURCE_EXCEEDS_1_MIB)
            chunks.push(Buffer.from(chunk))
          }
          try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
          catch { throw new GraphError(422, 'SOURCE_ENCODING', RuntimeMessage.SOURCE_MUST_CONTAIN_VALID_UTF_8) }
        } catch (error) { reject(error) }
        finally { response.destroy() }
      })
      pending.on('error', reject)
      pending.end()
    })
  }
  try { return await Promise.race([read(), timeout]) }
  catch (error) {
    if (error instanceof GraphError) throw error
    throw new GraphError(422, 'SOURCE_UNAVAILABLE', RuntimeMessage.SOURCE_REQUEST_FAILED)
  } finally { clearTimeout(timer); controller.abort() }
}
