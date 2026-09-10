import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { DshRunInput, DshRuntimeAPI } from '../contracts/dsh'

const MAX_BODY_BYTES = 1_048_576

function dshHttpWriteJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function dshHttpReadBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds 1 MiB')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function dshHttpReadRunInput(value: unknown): DshRunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object')
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.some(key => key !== 'prompt' && key !== 'sessionId')) {
    throw new Error('Request body contains unknown fields')
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    throw new Error('prompt must be a non-empty string')
  }
  if (input.sessionId !== undefined && typeof input.sessionId !== 'string') {
    throw new Error('sessionId must be a string')
  }
  return {
    prompt: input.prompt,
    sessionId: input.sessionId as string | undefined,
  }
}

export function dshHttpCreateServer(runtime: DshRuntimeAPI): Server {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        dshHttpWriteJson(response, 200, { ok: true })
        return
      }
      if (request.method !== 'POST' || request.url !== '/runtime/dsh/run') {
        dshHttpWriteJson(response, 404, { ok: false, error: 'Not found' })
        return
      }

      const input = dshHttpReadRunInput(await dshHttpReadBody(request))
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
      })
      const result = await runtime.run(input, event => {
        response.write(`${JSON.stringify({ type: 'event', event })}\n`)
      })
      response.end(`${JSON.stringify({ type: 'result', result })}\n`)
    } catch (error) {
      if (response.headersSent) {
        response.end(`${JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        })}\n`)
        return
      }
      dshHttpWriteJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}
