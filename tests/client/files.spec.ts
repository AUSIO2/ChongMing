// 文件客户端测试：覆盖上传幂等、下载完整性、大小限制、取消和权限错误。
import { randomUUID, createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCreateApi, clientCreateGateway } from '../../client/graph-client'
import { CLIENT_FILE_LIMIT } from '../../contracts/client'

const servers: Server[] = []
afterEach(async () => {
  // 每个用例结束后关闭测试 HTTP 服务及其存量连接。
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve =>
    /* 把服务器关闭回调转换为可等待的 Promise。 */
    server.close(() =>
      /* 服务器关闭完成后结束清理等待。 */
      resolve())) }
})
/**
 * @param bytes 待计算摘要的测试字节，只读。
 */
const digest = (
  bytes: Uint8Array
) => /* 计算测试字节的 SHA-256 摘要，用于构造和核对文件响应。 */ createHash('sha256').update(bytes).digest('hex')
/**
 * 构造带长度、摘要和中文下载文件名的有效文件响应。
 *
 * @param bytes 要返回的文件字节；默认使用 fixture 文本的 UTF-8 编码。
 */
function fileResponse(bytes = new TextEncoder().encode('fixture')) {
  return new Response(bytes, { headers: { 'content-type': 'text/plain', 'content-length': String(bytes.byteLength),
    'content-disposition': "attachment; filename*=UTF-8''%E6%96%87%E4%BB%B6.txt", etag: '"' + digest(bytes) + '"' } })
}

describe('bounded authenticated file client', () => {
  // 覆盖文件上传下载的大小、完整性、认证、取消和幂等请求约束。
  it('validates the decoded file digest when HTTP compression changes the wire length', async () => {
    // 验证 HTTP 压缩改变传输长度后仍按解压字节校验摘要。
    const original = Buffer.from('可被代理压缩的来源文件'), compressed = gzipSync(original)
    const server = createServer((_request, response) => {
      // 返回压缩内容与原始字节摘要，模拟代理压缩文件响应。
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': compressed.length,
        'content-disposition': 'attachment; filename="source.txt"', etag: '"' + digest(original) + '"' })
      response.end(compressed)
    })
    servers.push(server)
    await new Promise<void>(resolve => /* 监听本机临时端口，服务就绪时结束等待。 */ server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const client = clientCreateApi({ baseUrl: 'http://127.0.0.1:' + address.port, token: 'token' })
    expect(Buffer.from((await client.download({ kind: 'asset', id: randomUUID() })).bytes)).toEqual(original)
    client.close()
  })
  it('uploads frozen bytes with actual length/digest and reuses the exact retry identity', async () => {
    // 验证上传复制原字节，并在重试中保留文件内容、摘要和请求身份。
    const workspaceId = randomUUID(), requestId = randomUUID(), assetId = randomUUID()
    const seen: Array<{ url: string; digest: unknown; key: unknown; bytes: Buffer; auth: unknown }> = []
    const server = createServer(async (
      request,
      response
    ) => {
      // 记录实际上传头和字节，再返回与文件匹配的资产响应。
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      seen.push({ url: request.url!, digest: request.headers['x-content-sha256'], key: request.headers['idempotency-key'], bytes, auth: request.headers.authorization })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, requestId, replayed: seen.length > 1, data: {
        id: assetId, workspaceId, filename: '文件.txt', mediaType: 'text/plain', size: bytes.length, sha256: digest(bytes), createdAt: '',
      } }))
    })
    servers.push(server)
    await new Promise<void>(resolve => /* 监听本机临时端口，供真实上传请求访问。 */ server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const client = clientCreateApi({ baseUrl: 'http://127.0.0.1:' + address.port, token: 'file-token' })
    const original = new TextEncoder().encode('原始内容')
    const input = { workspaceId, filename: '文件.txt', mediaType: 'text/plain', bytes: original.slice() }
    const pending = client.upload(requestId, input)
    input.bytes.fill(0); input.workspaceId = randomUUID()
    expect((await pending).data.id).toBe(assetId)
    expect((await client.upload(requestId, { ...input, workspaceId, bytes: original })).replayed).toBe(true)
    expect(seen).toHaveLength(2)
    for (const call of seen) {
      expect(new URL(call.url, 'http://fixture').searchParams.get('workspaceId')).toBe(workspaceId)
      expect(call.bytes).toEqual(Buffer.from(original)); expect(call.digest).toBe(digest(original))
      expect(call.key).toBe(requestId); expect(call.auth).toBe('Bearer file-token')
    }
    client.close()
  })

  it('uses fixed download endpoints, verifies integrity and decodes safe filenames', async () => {
    // 验证三类下载使用固定端点，核对摘要并正确解码中文文件名。
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => /* 为各类下载返回同一份有效测试文件。 */ fileResponse())
    const client = clientCreateApi({ baseUrl: 'https://fixture.example', token: 'token', fetch: fetcher })
    const id = randomUUID()
    const file = await client.download({ kind: 'asset', id })
    expect(file.filename).toBe('文件.txt'); expect(new TextDecoder().decode(file.bytes)).toBe('fixture')
    await client.download({ kind: 'map', id }); await client.download({ kind: 'workspace', id })
    expect(fetcher.mock.calls.map(call => /* 提取已调用 URL，供固定下载路径断言。 */ String(call[0]))).toEqual([
      'https://fixture.example/api/v1/assets/' + id + '/content',
      'https://fixture.example/api/v1/maps/' + id + '/export',
      'https://fixture.example/api/v1/workspaces/' + id + '/export',
    ])
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', headers: { authorization: 'Bearer token' } })
    client.close()
  })

  it('rejects arbitrary URLs, paths, wrong byte types and oversize uploads before network access', async () => {
    // 验证任意 URL、路径文件名、错误字节类型和超限上传在联网前被拒绝。
    const fetcher = vi.fn<typeof fetch>()
    const client = clientCreateApi({ baseUrl: 'https://fixture.example', token: 'token', fetch: fetcher })
    await expect(client.download({ kind: 'asset', id: 'https://other.example/secret' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(client.download({ kind: 'asset', id: randomUUID(), url: 'https://other.example' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const upload = { workspaceId: randomUUID(), filename: 'x.txt', mediaType: 'text/plain', bytes: new Uint8Array() }
    await expect(client.upload(randomUUID(), { ...upload, filename: '../secret' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(client.upload(randomUUID(), { ...upload, bytes: [1, 2] } as never)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(client.upload(randomUUID(), { ...upload, bytes: new Uint8Array(CLIENT_FILE_LIMIT + 1) })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    expect(fetcher).not.toHaveBeenCalled(); client.close()
  })

  it('rejects excess streamed bytes, checksum errors, malformed names and length mismatches', async () => {
    // 验证流式超限、摘要错误、危险文件名和长度不符均返回对应错误。
    const chunk = new Uint8Array(CLIENT_FILE_LIMIT / 2 + 1)
    const streamed = new Response(new ReadableStream({
                                                       /**
                                                        * 产生超过文件大小上限的两个数据块后结束响应流。
                                                        *
                                                        * @param controller 测试可读流的生产端，追加超限字节后主动关闭。
                                                        */
                                                       start(controller) {
      controller.enqueue(chunk); controller.enqueue(chunk); controller.close()
    } }))
    const badHash = fileResponse(); badHash.headers.set('etag', '"' + '0'.repeat(64) + '"')
    const badName = fileResponse(); badName.headers.set('content-disposition', "attachment; filename*=UTF-8''..%2Fsecret")
    const wrongLength = fileResponse(); wrongLength.headers.set('content-length', '99')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(streamed).mockResolvedValueOnce(badHash).mockResolvedValueOnce(badName).mockResolvedValueOnce(wrongLength)
    const client = clientCreateApi({ baseUrl: 'https://fixture.example', token: 'token', fetch: fetcher }), input = { kind: 'asset' as const, id: randomUUID() }
    await expect(client.download(input)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(client.download(input)).rejects.toMatchObject({ code: 'FILE_INTEGRITY' })
    await expect(client.download(input)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(client.download(input)).rejects.toMatchObject({ code: 'FILE_INTEGRITY' })
    client.close()
  })

  it('preserves cancellation and structured authorization errors on file requests', async () => {
    // 验证文件请求取消保留取消错误，服务端拒绝保留结构化权限错误。
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (
      _url,
      init
    ) => /* 模拟只有取消信号才结束的文件网络请求。 */ new Promise((
      _resolve,
      reject
    ) => {
      // 为测试网络请求安装取消拒绝回调。
      init!.signal!.addEventListener('abort', () => /* 收到取消后拒绝模拟网络请求。 */ reject(new Error('aborted')), { once: true })
    }))
    const client = clientCreateApi({ baseUrl: 'https://fixture.example', token: 'token', fetch: fetcher })
    const controller = new AbortController(), pending = client.download({ kind: 'asset', id: randomUUID() }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    fetcher.mockResolvedValueOnce(Response.json({ ok: false, requestId: randomUUID(), error: { code: 'FORBIDDEN', message: 'Membership changed', retryable: false } }, { status: 403 }))
    await expect(client.download({ kind: 'asset', id: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    client.close()
  })

  it('rejects a late download after the gateway disconnects', async () => {
    /**
     * 验证网关断开后不会接纳迟到的下载结果。
     *
     * @param response 测试稍后手动交付的文件 HTTP 响应。
     */
    let deliver!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, requestId: randomUUID(), replayed: false, data: {
      identity: { userId: randomUUID(), displayName: 'Owner', hostAdmin: false },
      settings: { revision: 0, llm: {}, tools: [], limits: {} }, metadata: {},
    } })).mockImplementationOnce(async () => /* 延迟文件响应，供测试在断开连接后手动交付。 */ new Promise(resolve => {
        // 保存延迟响应的完成函数。
        deliver = resolve
    }))
    const gateway = clientCreateGateway({ baseUrl: 'https://fixture.example', fetch: fetcher })
    await gateway.connect({ baseUrl: 'https://fixture.example', token: 'token', remember: false })
    const pending = gateway.download({ kind: 'asset', id: randomUUID() })
    await vi.waitFor(() => /* 等待登录和下载两个请求均已发出，再触发断开。 */ expect(fetcher).toHaveBeenCalledTimes(2))
    await gateway.disconnect(); deliver(fileResponse())
    await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    gateway.close()
  })
})
