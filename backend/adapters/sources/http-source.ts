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
// 用途：读取地址，并把结构化结果交给调用方。
export async function sourceReadUrl(value: string, allowPrivate = false): Promise<string> {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new GraphError(422, 'INVALID_SOURCE', RuntimeMessage.SOURCE_URL_MUST_USE_HTTP_S_WITHOUT_CREDENTIALS)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new GraphError(422, 'SOURCE_UNAVAILABLE', RuntimeMessage.SOURCE_REQUEST_TIMED_OUT))
    }, 10_000)
  })
  const read = async () => {
    const family = isIP(hostname)
    const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true, verbatim: true })
    controller.signal.throwIfAborted()
    if (!addresses.length || (!allowPrivate && addresses.some(item => blocked.check(item.address, item.family === 6 ? 'ipv6' : 'ipv4')))) {
      throw new GraphError(422, 'SOURCE_ADDRESS_BLOCKED', RuntimeMessage.SOURCE_URL_MUST_RESOLVE_TO_A_PUBLIC_INTERNET_ADDRESS)
    }
    const destination = addresses[0]
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    return new Promise<string>((resolve, reject) => {
      const pending = request(url, {
        signal: controller.signal,
        family: destination.family,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [destination])
          else callback(null, destination.address, destination.family)
        },
        headers: { accept: [...SOURCE_MEDIA_TYPES].join(', ') },
      }, async response => {
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
