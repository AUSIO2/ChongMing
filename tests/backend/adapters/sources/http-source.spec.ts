// 文件职责：以隔离 HTTP 服务验证来源地址、媒体类型、大小、编码和重定向边界。
import { createServer, request, type Server } from 'node:http'
import { lookup } from 'node:dns/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceReadUrl } from '../../../../backend/adapters/sources/http-source'

vi.mock('node:http', async /* Vitest 提供的原模块加载器，先取得真实 HTTP 实现再只代理 request。 */ importOriginal => {
  // 保留真实 HTTP 模块并代理 request，以检测是否越过地址校验提前联网。
  const original = await importOriginal<typeof import('node:http')>()
  const guardedRequest = vi.fn(original.request)
  return { ...original, request: guardedRequest, default: { ...original.default, request: guardedRequest } }
})
vi.mock('node:dns/promises', async /* Vitest 原模块加载器，取得真实 DNS API 后替换 lookup 以注入地址集合。 */ importOriginal => {
  // 代理 DNS 查询，允许测试注入公私混合的地址结果。
  const original = await importOriginal<typeof import('node:dns/promises')>()
  return { ...original, lookup: vi.fn(original.lookup) }
})

let server: Server, baseUrl: string
const visits: string[] = []
const text = '多来源新闻 — café'

beforeAll(async () => {
  // 建立只监听回环地址的来源夹具，并记录实际访问路径。
  server = createServer((/* 本地来源夹具收到的请求，根据 URL 路径选择测试响应并记录访问。 */ incoming, /* 夹具响应流，可写正常正文、重定向、非法媒体或超限字节。 */ response) => {
    // 按路径返回重定向、二进制、大响应、错误编码或正常文本。
    visits.push(incoming.url!)
    if (incoming.url === '/redirect') {
      response.writeHead(302, { location: '/text' }); response.end(); return
    }
    if (incoming.url === '/binary') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end('binary'); return
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    if (incoming.url === '/large') {
      response.write(Buffer.alloc(524_288, 'a')); response.end(Buffer.alloc(524_289, 'b')); return
    }
    if (incoming.url === '/invalid-utf8') { response.end(Buffer.from([0xff, 0xfe])); return }
    response.end(text)
  })
  await new Promise<void>(/* 本地来源服务器监听成功后的启动兑现回调。 */ resolve => /* 等待本地来源服务绑定临时端口。 */  server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Source fixture did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(() => {
  // 每个用例开始前清空访问记录与请求调用计数。
   visits.length = 0; vi.mocked(request).mockClear() })
afterAll(async () => {
  // 关闭来源服务及存量连接，等待监听端口释放。
  server.closeAllConnections()
  await new Promise<void>((/* 来源服务成功关闭后的清理完成回调。 */ resolve, /* 来源服务关闭失败后的清理拒绝回调。 */ reject) => /* 把 HTTP 服务关闭回调转换为可等待的 Promise。 */  server.close(/* HTTP 服务器关闭返回的可选错误，转为清理 Promise 的失败。 */ error => /* 根据服务关闭结果完成或拒绝测试清理。 */  error ? reject(error) : resolve()))
})

describe('Source URL network boundary', () => {
  // 覆盖来源获取从地址解析到正文解码的输入边界。
  it('rejects loopback, private and metadata destinations before opening a connection', async () => {
    // 验证回环、私网和元数据地址在建立任何连接前被拒绝。
    // A failing address check must fail this test without ever contacting a real private service.
    await vi.mocked(request).withImplementation(() => {
      // 一旦地址防护失效而尝试联网，立即让用例失败。
       throw new Error('Unexpected network connection') }, async () => {
      // 逐一检查禁止地址的错误码，并确认没有网络调用或本地访问。
      for (const url of [baseUrl, 'http://[::1]/text', 'http://10.0.0.1/text', 'http://192.168.1.1/text',
        'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/text']) {
        await expect(sourceReadUrl(url)).rejects.toMatchObject({ code: 'SOURCE_ADDRESS_BLOCKED' })
      }
      expect(request).not.toHaveBeenCalled()
      expect(visits).toEqual([])
    })
  })

  it('rejects a DNS answer set containing a private address without connecting to any answer', async () => {
    // 注入含私网地址的 DNS 集合，验证整组结果被拒绝而非挑选公网地址。
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 },
    ])
    await vi.mocked(request).withImplementation(() => {
      // 若混合 DNS 结果导致连接请求，立即报告防护失效。
       throw new Error('Unexpected network connection') }, async () => {
      // 验证混合地址来源被拒绝且 HTTP 请求从未发出。
      await expect(sourceReadUrl('http://source-test.invalid/text')).rejects.toMatchObject({ code: 'SOURCE_ADDRESS_BLOCKED' })
      expect(request).not.toHaveBeenCalled()
    })
  })

  it('reads UTF-8 from the isolated local server only with the explicit private-source flag', async () => {
    // 仅显式允许测试私网时读取本地 UTF-8 来源。
    expect(await sourceReadUrl(`${baseUrl}/text`, true)).toBe(text)
    expect(visits).toEqual(['/text'])
  })

  it('rejects unsupported media instead of interpreting arbitrary bytes as text', async () => {
    // 验证二进制媒体类型不会被当作文本解释。
    await expect(sourceReadUrl(`${baseUrl}/binary`, true)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' })
    expect(visits).toEqual(['/binary'])
  })

  it('enforces the byte limit on a chunked response without Content-Length', async () => {
    // 验证缺少 Content-Length 的分块响应仍受 1 MiB 大小限制。
    await expect(sourceReadUrl(`${baseUrl}/large`, true)).rejects.toMatchObject({ code: 'SOURCE_LIMIT' })
    expect(visits).toEqual(['/large'])
  })

  it('rejects malformed UTF-8', async () => {
    // 验证非法 UTF-8 字节触发编码错误。
    await expect(sourceReadUrl(`${baseUrl}/invalid-utf8`, true)).rejects.toMatchObject({ code: 'SOURCE_ENCODING' })
    expect(visits).toEqual(['/invalid-utf8'])
  })

  it('does not follow a redirect even when both addresses are local test destinations', async () => {
    // 验证来源请求拒绝重定向，目标路径不会被访问。
    await expect(sourceReadUrl(`${baseUrl}/redirect`, true)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    expect(visits).toEqual(['/redirect'])
  })
})
