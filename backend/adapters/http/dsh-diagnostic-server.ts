import { RuntimeMessage } from '../../../contracts/messages'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { DshRunInput, DshRuntimeAPI } from '../../../contracts/dsh'

const MAX_BODY_BYTES = 1_048_576

// 用途：处理DSH 运行时相关工作，并把结果交给调用方。
function dshHttpWriteJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

// 用途：处理DSH 运行时相关工作，并把结果交给调用方。
async function dshHttpReadBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error(RuntimeMessage.REQUEST_BODY_EXCEEDS_1_MIB)
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// 用途：处理DSH 运行时相关工作，并把结果交给调用方。
function dshHttpReadRunInput(value: unknown): DshRunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(RuntimeMessage.REQUEST_BODY_MUST_BE_AN_OBJECT)
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.some(key => key !== 'prompt' && key !== 'sessionId')) {
    throw new Error(RuntimeMessage.REQUEST_BODY_CONTAINS_UNKNOWN_FIELDS)
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    throw new Error(RuntimeMessage.PROMPT_MUST_BE_A_NON_EMPTY_STRING)
  }
  if (input.sessionId !== undefined && typeof input.sessionId !== 'string') {
    throw new Error(RuntimeMessage.SESSIONID_MUST_BE_A_STRING)
  }
  return {
    prompt: input.prompt,
    sessionId: input.sessionId as string | undefined,
  }
}

// 用途：处理DSH 运行时相关工作，并把结果交给调用方。
export function dshHttpCreateServer(runtime: DshRuntimeAPI): Server {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        dshHttpWriteJson(response, 200, { ok: true })
        return
      }
      if (request.method !== 'POST' || request.url !== '/runtime/dsh/run') {
        dshHttpWriteJson(response, 404, { ok: false, error: RuntimeMessage.NOT_FOUND })
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
