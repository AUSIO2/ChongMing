// 文件职责：提供 DSH 诊断 HTTP 入口，以 NDJSON 输出运行事件和最终结果。
import { RuntimeMessage } from '../../../contracts/messages'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { DshRunInput, DshRuntimeAPI } from '../../../contracts/dsh'

const MAX_BODY_BYTES = 1_048_576
function dshHttpWriteJson(/* 本次诊断请求的响应流，函数写出 JSON 后结束它。 */ response: ServerResponse, /* 发送给诊断调用者的 HTTP 状态码。 */ status: number, /* 可序列化为 JSON 的诊断结果或错误对象。 */ body: unknown): void {
  // 写出指定状态的 JSON 诊断响应并结束请求。
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
async function dshHttpReadBody(/* 客户端上传的原始请求流，读取时实施 1 MiB 上限。 */ request: IncomingMessage): Promise<unknown> {
  // 流式读取至多 1 MiB 请求体并解析为 JSON。
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
function dshHttpReadRunInput(/* 尚未验证的 JSON 请求体，需解析为提示词及可选会话身份。 */ value: unknown): DshRunInput {
  // 只接受非空提示词和可选会话身份，拒绝未知字段。
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(RuntimeMessage.REQUEST_BODY_MUST_BE_AN_OBJECT)
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.some(/* 请求体中的字段名，用于排除协议外输入。 */ key => /* 识别提示词与会话身份之外的输入字段。 */  key !== 'prompt' && key !== 'sessionId')) {
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
export function dshHttpCreateServer(/* 由部署入口提供的 DSH 运行时，本服务器调用但不负责其关闭。 */ runtime: DshRuntimeAPI): Server {
  // 将 DSH 运行时暴露为健康检查与诊断执行接口。
  return createServer(async (/* 待路由的诊断 HTTP 请求及其正文流。 */ request, /* 本请求的 HTTP 输出流，运行成功后改用 NDJSON 逐条发送。 */ response) => {
    // 路由诊断请求，校验输入并按响应是否开始选择 JSON 或流内错误。
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
      const result = await runtime.run(input, /* 运行时已经投影为 JSON 数据的单条执行通知。 */ event => {
        // 把每条 DSH 通知编码为独立 NDJSON 事件帧。
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
