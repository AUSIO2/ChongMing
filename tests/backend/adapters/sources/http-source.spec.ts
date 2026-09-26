import { createServer, request, type Server } from 'node:http'
import { lookup } from 'node:dns/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceReadUrl } from '../../../../backend/adapters/sources/http-source'

vi.mock('node:http', async importOriginal => {
  const original = await importOriginal<typeof import('node:http')>()
  const guardedRequest = vi.fn(original.request)
  return { ...original, request: guardedRequest, default: { ...original.default, request: guardedRequest } }
})
vi.mock('node:dns/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:dns/promises')>()
  return { ...original, lookup: vi.fn(original.lookup) }
})

let server: Server, baseUrl: string
const visits: string[] = []
const text = '多来源新闻 — café'

beforeAll(async () => {
  server = createServer((incoming, response) => {
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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Source fixture did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(() => { visits.length = 0; vi.mocked(request).mockClear() })
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('Source URL network boundary', () => {
  it('rejects loopback, private and metadata destinations before opening a connection', async () => {
    // A failing address check must fail this test without ever contacting a real private service.
    await vi.mocked(request).withImplementation(() => { throw new Error('Unexpected network connection') }, async () => {
      for (const url of [baseUrl, 'http://[::1]/text', 'http://10.0.0.1/text', 'http://192.168.1.1/text',
        'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/text']) {
        await expect(sourceReadUrl(url)).rejects.toMatchObject({ code: 'SOURCE_ADDRESS_BLOCKED' })
      }
      expect(request).not.toHaveBeenCalled()
      expect(visits).toEqual([])
    })
  })

  it('rejects a DNS answer set containing a private address without connecting to any answer', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 },
    ])
    await vi.mocked(request).withImplementation(() => { throw new Error('Unexpected network connection') }, async () => {
      await expect(sourceReadUrl('http://source-test.invalid/text')).rejects.toMatchObject({ code: 'SOURCE_ADDRESS_BLOCKED' })
      expect(request).not.toHaveBeenCalled()
    })
  })

  it('reads UTF-8 from the isolated local server only with the explicit private-source flag', async () => {
    expect(await sourceReadUrl(`${baseUrl}/text`, true)).toBe(text)
    expect(visits).toEqual(['/text'])
  })

  it('rejects unsupported media instead of interpreting arbitrary bytes as text', async () => {
    await expect(sourceReadUrl(`${baseUrl}/binary`, true)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' })
    expect(visits).toEqual(['/binary'])
  })

  it('enforces the byte limit on a chunked response without Content-Length', async () => {
    await expect(sourceReadUrl(`${baseUrl}/large`, true)).rejects.toMatchObject({ code: 'SOURCE_LIMIT' })
    expect(visits).toEqual(['/large'])
  })

  it('rejects malformed UTF-8', async () => {
    await expect(sourceReadUrl(`${baseUrl}/invalid-utf8`, true)).rejects.toMatchObject({ code: 'SOURCE_ENCODING' })
    expect(visits).toEqual(['/invalid-utf8'])
  })

  it('does not follow a redirect even when both addresses are local test destinations', async () => {
    await expect(sourceReadUrl(`${baseUrl}/redirect`, true)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    expect(visits).toEqual(['/redirect'])
  })
})
