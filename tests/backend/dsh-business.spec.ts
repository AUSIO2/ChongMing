import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

let server: Server | undefined

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
  server = undefined
  delete process.env.CHONGMING_DATA_API
})

describe('DSH business tools', () => {
  it('forwards validated read and propose calls to the data API', async () => {
    const received: Array<{ url: string; body: unknown }> = []
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.push({ url: request.url ?? '', body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, data: { accepted: true } }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Tool test server did not bind')
    process.env.CHONGMING_DATA_API = `http://127.0.0.1:${address.port}`

    const modulePath = '../../backend/dsh-business-plugin.mjs'
    const plugin = await import(modulePath) as {
      apply(ctx: { tools: { register(tool: Tool): void } }): void
    }
    const tools = new Map<string, Tool>()
    plugin.apply({ tools: { register: tool => void tools.set(tool.name, tool) } })
    const exec = { signal: new AbortController().signal }

    await expect(tools.get('data_read')!.execute({
      mapId: 'map-1', operationId: 'operation-1',
    }, exec)).resolves.toEqual({ accepted: true })
    await expect(tools.get('data_propose')!.execute({
      mapId: 'map-1',
      operationId: 'operation-1',
      report: { id: 'report-1', slotId: 'logic', score: 0.5, reason: 'uncertain' },
    }, exec)).resolves.toEqual({ accepted: true })
    expect(received).toEqual([
      {
        url: '/internal/v1/data/read',
        body: { mapId: 'map-1', operationId: 'operation-1' },
      },
      {
        url: '/internal/v1/data/propose',
        body: {
          mapId: 'map-1',
          operationId: 'operation-1',
          report: { id: 'report-1', slotId: 'logic', score: 0.5, reason: 'uncertain' },
        },
      },
    ])
  })
})

interface Tool {
  name: string
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}
