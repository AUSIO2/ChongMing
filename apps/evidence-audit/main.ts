// 仓颉证据图审计CLI：只读获取图，调用仓颉并写出新的报告文件。
import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { clientCreateApi } from '../../client/graph-client'
import { AUDIT_INPUT_LIMIT_BYTES, AuditError, AuditMessage, auditRunCangjie } from './audit-process'

const help = `Usage: node --import tsx apps/evidence-audit/main.ts <source> [options]
  --input PATH                 Read a graph JSON file or {ok:true,data:graph} reply
  --map-id UUID                Read a graph through the public API
  --url URL                    API URL; defaults to CHONGMING_GRAPH_API or http://127.0.0.1:4320
  --token-file PATH            API user token; otherwise CHONGMING_USER_TOKEN
  --format json|markdown       Output format; default json
  --output PATH                Create a new report; existing files are never overwritten

Set CHONGMING_CANGJIE_AUDIT_BIN to override apps/evidence-audit-cj/bin/evidence-audit.
Limits: input 10 MiB, process output 32 MiB, execution 30 seconds.
Exit codes: 0 pass/warning, 1 structural errors, 2 invalid input, 3 execution failure.
This command checks graph structure, not the truth of the news; it never writes graph data.
`

type InputSource = { kind: 'file'; path: string } | { kind: 'api'; mapId: string; url: string; tokenFile?: string }
interface CommandOptions { source: InputSource; format: 'json' | 'markdown'; output?: string }

export async function auditRunCommand(/* 不包含Node与脚本路径的命令行参数。 */ argv: string[],
  /* 调用方取消本次API读取与仓颉子进程。 */ signal?: AbortSignal): Promise<number> {
  // 读取只读输入、等待仓颉报告，按用户指定格式输出；不覆盖既有报告。
  const options = readOptions(argv)
  if (options === null) { await writeStandardOutput(help, signal); return 0 }
  const input = await readInput(options.source, signal)
  const result = await auditRunCangjie({ input, signal })
  // invalid没有可用报告，即便请求Markdown也输出结构化错误而不生成成功文件。
  if (result.status === 'invalid') { process.stderr.write(JSON.stringify(result) + '\n'); return 2 }
  const output = options.format === 'json' ? JSON.stringify(result, null, 2) + '\n' : result.markdown + (result.markdown.endsWith('\n') ? '' : '\n')
  if (options.output) {
    try { await writeFile(options.output, output, { flag: 'wx', mode: 0o600, signal }) }
    catch { throw new AuditError('AUDIT_OUTPUT_FAILED', AuditMessage.OUTPUT_FAILED, 3) }
  } else await writeStandardOutput(output, signal)
  return result.status === 'fail' ? 1 : 0
}

async function writeStandardOutput(/* 本次审计独占的一份完整输出文本。 */ text: string,
  /* 调用方取消等待输出并关闭未完成管道。 */ signal?: AbortSignal): Promise<void> {
  // 等待管道实际接纳输出；只在本次写入期间监听错误，EPIPE不冒充图结构失败。
  if (signal?.aborted) throw new AuditError('AUDIT_CANCELLED', AuditMessage.CANCELLED, 3)
  await new Promise<void>((/* 输出已被接纳后完成等待。 */ resolve, /* 输出失败时返回受控执行错误。 */ reject) => {
    // Promise拥有本次写入的计时器与监听；超时或取消销毁阻塞管道以有界结束。
    let settled = false
    const stream = process.stdout
    function finish(/* 成功时省略，失败时只保留受控错误。 */ error?: AuditError): void {
      // 统一释放本次监听和计时器，避免导入模块或多次调用累积全局副作用。
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      stream.removeListener('error', onError); stream.removeListener('close', onClose)
      if (error) reject(error); else resolve()
    }
    function onError(/* stdout异步发出的错误，包括下游提前关闭的EPIPE。 */ error: Error): void {
      // 原生错误不回显堆栈，输出失败统一使用退出码3。
      finish(error instanceof AuditError ? error : new AuditError('AUDIT_STDOUT_FAILED', AuditMessage.FAILED, 3))
    }
    const onClose = () => /* 管道未完成写入就关闭时，结束等待并报告输出失败。 */ finish(new AuditError('AUDIT_STDOUT_FAILED', AuditMessage.FAILED, 3))
    const abort = () => /* 停止仍阻塞的输出，错误事件负责完成Promise清理。 */ stream.destroy(new AuditError('AUDIT_CANCELLED', AuditMessage.CANCELLED, 3))
    const timer = setTimeout(() => {
      // 30秒内仍未接纳输出时关闭管道，使进程不会因背压无限滞留。
      stream.destroy(new AuditError('AUDIT_STDOUT_TIMEOUT', AuditMessage.FAILED, 3))
    }, 30_000)
    stream.once('error', onError); stream.once('close', onClose)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    try {
      stream.write(text, (/* Node在错误事件之前传入的本次写入错误。 */ error?: Error | null) => {
        // 失败时继续保留error监听：Node保证先调用此回调，再发出error事件。
        if (!error) finish()
      })
    } catch { finish(new AuditError('AUDIT_STDOUT_FAILED', AuditMessage.FAILED, 3)) }
  })
}

function readOptions(/* 命令行原始参数，只允许已声明选项。 */ argv: string[]): CommandOptions | null {
  // 明确区分文件与API模式，避免文件审计意外读取凭据或发起网络请求。
  let values
  try {
    values = parseArgs({ args: argv, allowPositionals: false, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, input: { type: 'string' }, 'map-id': { type: 'string' },
      url: { type: 'string' }, 'token-file': { type: 'string' }, format: { type: 'string' }, output: { type: 'string' },
    } }).values
  } catch { throw new AuditError('AUDIT_USAGE', AuditMessage.USAGE, 2) }
  if (values.help) return null
  if (Boolean(values.input) === Boolean(values['map-id']) || (values.format !== undefined && values.format !== 'json' && values.format !== 'markdown')
    || values.output === '' || values['token-file'] === '' || values.url === '') throw new AuditError('AUDIT_USAGE', AuditMessage.USAGE, 2)
  const format = values.format === 'markdown' ? 'markdown' : 'json'
  if (values.input) {
    if (values.url !== undefined || values['token-file'] !== undefined) throw new AuditError('AUDIT_USAGE', AuditMessage.USAGE, 2)
    return { source: { kind: 'file', path: values.input }, format, output: values.output }
  }
  const mapId = values['map-id']
  if (!mapId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mapId)) throw new AuditError('AUDIT_USAGE', AuditMessage.USAGE, 2)
  return { source: { kind: 'api', mapId, url: values.url ?? process.env.CHONGMING_GRAPH_API ?? 'http://127.0.0.1:4320', tokenFile: values['token-file'] }, format, output: values.output }
}

async function readBoundedFile(/* 本次已选定的文件路径。 */ filename: string,
  /* 限制当前读取的最大字节数。 */ limitBytes: number,
  /* 取消文件读取并释放流的信号。 */ signal?: AbortSignal): Promise<string> {
  // 按块读取有界UTF-8文本，文件读取过程中增长也不能超过预算。
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of createReadStream(filename, { signal, highWaterMark: 64 * 1024 })) {
      size += chunk.length
      if (size > limitBytes) throw new AuditError('AUDIT_INPUT_TOO_LARGE', AuditMessage.INPUT_TOO_LARGE, 2)
      chunks.push(chunk)
    }
  } catch (error) {
    // 保留已分类限额错误，其余文件失败不向stderr泄漏本机路径。
    if (error instanceof AuditError) throw error
    if (signal?.aborted) throw new AuditError('AUDIT_CANCELLED', AuditMessage.CANCELLED, 3)
    throw new AuditError('AUDIT_INPUT_READ_FAILED', AuditMessage.INPUT_READ_FAILED, 3)
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
  catch { throw new AuditError('AUDIT_INPUT_INVALID', AuditMessage.INPUT_INVALID, 2) }
}

async function readInput(/* 已区分文件与API的输入来源。 */ source: InputSource,
  /* 取消读取与公共API请求的信号。 */ signal?: AbortSignal): Promise<unknown> {
  // 文件模式只解析JSON；API模式只调用map.get，令牌在调用完成后不传给仓颉。
  if (source.kind === 'file') {
    const text = await readBoundedFile(source.path, AUDIT_INPUT_LIMIT_BYTES, signal)
    try { return JSON.parse(text) }
    catch { throw new AuditError('AUDIT_INPUT_INVALID', AuditMessage.INPUT_INVALID, 2) }
  }
  const token = source.tokenFile ? (await readBoundedFile(source.tokenFile, 64 * 1024, signal)).trim() : process.env.CHONGMING_USER_TOKEN?.trim()
  if (!token) throw new AuditError('AUDIT_TOKEN_REQUIRED', AuditMessage.TOKEN_REQUIRED, 2)
  const client = clientCreateApi({ baseUrl: source.url, token })
  try { return await client.read('map.get', { mapId: source.mapId }, signal) }
  catch {
    if (signal?.aborted) throw new AuditError('AUDIT_CANCELLED', AuditMessage.CANCELLED, 3)
    throw new AuditError('AUDIT_API_FAILED', AuditMessage.API_FAILED, 3)
  } finally { client.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const cancel = () => /* 命令行中断只取消本次审计，不触碰共享图任务。 */ controller.abort()
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  auditRunCommand(process.argv.slice(2), controller.signal).then((/* 审计协议对应的退出码。 */ code) => {
    // 成功完成审计也保留结构问题对应的非零退出码。
    process.exitCode = code
  }).catch((/* 输入、I/O或仓颉执行产生的失败。 */ error: unknown) => {
    // 只输出受控错误，不回显API响应、令牌或原生异常路径。
    const failure = error instanceof AuditError ? error : new AuditError('AUDIT_FAILED', AuditMessage.FAILED, 3)
    process.stderr.write(JSON.stringify({ protocolVersion: 1, status: failure.exitCode === 2 ? 'invalid' : 'execution-error', error: { code: failure.code, message: failure.message } }) + '\n')
    process.exitCode = failure.exitCode
  }).finally(() => {
    // 移除CLI拥有的信号监听，完成后允许Node自然退出。
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
  })
}
