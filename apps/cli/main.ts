// 命令行客户端入口：校验参数、读取输入并通过公共 API 输出 JSON 或事件流。
import { RuntimeMessage } from '../../contracts/messages'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { clientCreateApi, CLIENT_COMMAND_METHODS, CLIENT_QUERY_METHODS, ClientError } from '../../client/graph-client'
import { CLIENT_FILE_LIMIT, type CommandInputMap, type QueryInputMap } from '../../contracts/client'
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRegisterBoundary } from '../../platform/node/process-boundary'

const reporter = diagnosticCreateReporter({ component: 'client-cli' })
processRegisterBoundary({ component: 'client-cli', reporter })
process.stdout.on('error', /* 标准输出流报告的故障；仅 EPIPE 视为消费端已关闭管道。 */ error => {
  // 输出管道关闭时记录事件并退出，其他标准输出错误继续交给进程错误边界。
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    reporter.report({ name: 'cli.output.closed', severity: 'info' })
    process.exit(1)
  }
  throw error
})

const help = `Usage: npm run headless -- <command> [options]
  read METHOD [--input JSON_FILE|-]
  dispatch METHOD --request-id UUID [--input JSON_FILE|-]
  watch MAP_ID
  upload --workspace UUID --file PATH --request-id UUID [--media-type TYPE]
  download <asset|map|workspace> UUID --output PATH

Connection: --url URL (or CHONGMING_GRAPH_API, default http://127.0.0.1:4320)
Authentication: --token-file PATH or CHONGMING_USER_TOKEN; never use a Host token.
--help is offline. Results and stream events are JSON/NDJSON.
Input defaults to {}. '-' reads JSON from stdin. Input/file limit: 64 MiB.
Writes require a stable --request-id; retry an uncertain write with the same ID and body.
Downloads create a new file and refuse to overwrite an existing file.
Ctrl+C stops this client; it does not pause or cancel shared work.
Queries: ${CLIENT_QUERY_METHODS.join(', ')}
Commands: ${CLIENT_COMMAND_METHODS.join(', ')}
`

function cliThrowUsage(/* 准备输出给命令行使用者的参数错误说明。 */ message: string): never {
  // 将命令行参数错误包装为不可重试的用法错误，供入口选择退出码。
  throw new ClientError({ status: 0, code: 'CLI_USAGE', message, retryable: false })
}
async function cliReadBytes(/* 调用方指定的本地文件路径，读取前后均检查大小。 */ file: string): Promise<Uint8Array> {
  // 读取文件字节，并在读取前后检查 64 MiB 上限以覆盖文件增长。
  if ((await stat(file)).size > CLIENT_FILE_LIMIT) cliThrowUsage('Input exceeds 64 MiB')
  const bytes = await readFile(file)
  if (bytes.byteLength > CLIENT_FILE_LIMIT) cliThrowUsage('Input exceeds 64 MiB')
  return bytes
}
async function cliReadInput(/* 可选输入来源；横杠表示标准输入，省略时使用空对象。 */ file?: string): Promise<Record<string, unknown>> {
  // 从文件或标准输入读取有大小限制的 JSON，并只接受对象作为请求参数。
  let source = '{}'
  if (file === '-') {
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); size += bytes.length
      if (size > CLIENT_FILE_LIMIT) cliThrowUsage('Input exceeds 64 MiB')
      chunks.push(bytes)
    }
    source = Buffer.concat(chunks).toString('utf8')
  } else if (file) source = Buffer.from(await cliReadBytes(file)).toString('utf8')
  let value: unknown
  try { value = JSON.parse(source) } catch { cliThrowUsage('Input must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) cliThrowUsage('Input must be a JSON object')
  return value as Record<string, unknown>
}
function cliReadId(/* 来自命令行的待验证标识，缺失或非 UUID 均拒绝。 */ value: string | undefined): string {
  // 校验必填 UUID，拒绝缺失或格式错误的命令行标识。
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) cliThrowUsage('A UUID is required')
  return value
}

export async function cliRun(/* 不含 Node 可执行文件和脚本路径的命令行参数列表。 */ argv: string[]): Promise<void> {
  // 解析并执行读写、订阅或文件命令，管理连接取消与退出时的客户端清理。
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, url: { type: 'string' }, 'token-file': { type: 'string' },
    input: { type: 'string' }, 'request-id': { type: 'string' }, workspace: { type: 'string' },
    file: { type: 'string' }, 'media-type': { type: 'string' }, output: { type: 'string' },
  } })
  if (values.help) { process.stdout.write(help); return }
  const [command, method] = positionals
  const allowed: Record<string, string[]> = { read: ['input'], dispatch: ['input', 'request-id'], watch: [],
    upload: ['workspace', 'file', 'request-id', 'media-type'], download: ['output'] }
  if (!Object.prototype.hasOwnProperty.call(allowed, command ?? '')) cliThrowUsage('Choose read, dispatch, watch, upload or download; use --help')
  if (Object.keys(values).some(/* parseArgs 识别出的选项名，用于检查当前子命令是否允许。 */ key => /* 发现当前子命令不允许使用的选项。 */  !['url', 'token-file', ...allowed[command]].includes(key))) cliThrowUsage('Option does not belong to this command')
  if (positionals.length !== (command === 'upload' ? 1 : command === 'download' ? 3 : 2)) cliThrowUsage('Unexpected or missing positional argument')
  if (command === 'read' && !CLIENT_QUERY_METHODS.some(/* 公开查询清单中的候选方法名，与用户输入比较。 */ item => /* 检查输入是否属于公开查询方法。 */  item === method)) cliThrowUsage('Unknown query method')
  if (command === 'dispatch' && !CLIENT_COMMAND_METHODS.some(/* 公开写命令清单中的候选方法名，与用户输入比较。 */ item => /* 检查输入是否属于公开写命令。 */  item === method)) cliThrowUsage('Unknown command method')
  const requestId = command === 'dispatch' || command === 'upload' ? cliReadId(values['request-id']) : ''
  if (command === 'watch') cliReadId(method)
  if (command === 'download') {
    if (!['asset', 'map', 'workspace'].includes(method) || !values.output) cliThrowUsage('download requires kind, UUID and --output')
    cliReadId(positionals[2])
  }
  if (command === 'upload') { cliReadId(values.workspace); if (!values.file) cliThrowUsage('upload requires --file') }
  const params = command === 'read' || command === 'dispatch' ? await cliReadInput(values.input) : {}
  const token = values['token-file'] ? Buffer.from(await cliReadBytes(values['token-file'])).toString('utf8').trim() : process.env.CHONGMING_USER_TOKEN?.trim()
  if (!token) cliThrowUsage('Set CHONGMING_USER_TOKEN or --token-file')
  const client = clientCreateApi({ baseUrl: values.url ?? process.env.CHONGMING_GRAPH_API ?? 'http://127.0.0.1:4320', token })
  const stop = new AbortController()
  const interrupt = () => /* 收到终止信号时取消当前客户端请求。 */  stop.abort()
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  try {
    if (command === 'watch') {
      await client.watch(method, /* 客户端已解析的图订阅事件，逐条编码为 NDJSON。 */ event => {
        // 将每个订阅事件作为一行 JSON 输出，供管道逐条消费。
         process.stdout.write(JSON.stringify(event) + '\n') }, stop.signal)
      return
    }
    let result: unknown
    if (command === 'read') result = { ok: true, data: await client.read(method as keyof QueryInputMap, params as QueryInputMap[keyof QueryInputMap], stop.signal) }
    else if (command === 'dispatch') result = await client.dispatch(requestId, method as keyof CommandInputMap, params as CommandInputMap[keyof CommandInputMap], stop.signal)
    else if (command === 'upload') result = await client.upload(requestId, { workspaceId: values.workspace!, filename: path.basename(values.file!),
      mediaType: values['media-type'] ?? 'application/octet-stream', bytes: await cliReadBytes(values.file!) }, stop.signal)
    else {
      const file = await client.download({ kind: method as 'asset' | 'map' | 'workspace', id: positionals[2] }, stop.signal)
      stop.signal.throwIfAborted()
      await writeFile(values.output!, file.bytes, { flag: 'wx', mode: 0o600 })
      result = { ok: true, path: path.resolve(values.output!), filename: file.filename, mediaType: file.mediaType, bytes: file.bytes.byteLength }
    }
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    if (stop.signal.aborted) { process.exitCode = 130; return }
    throw error
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); client.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cliRun(process.argv.slice(2)).catch(/* 命令执行拒绝的原因；已知客户端错误保留协议字段，其他错误脱敏。 */ error => {
    // 将入口错误写为结构化 JSON，保留诊断编号并设置用法或执行失败退出码。
    const errorId = error instanceof ClientError ? error.errorId : reporter.report({ name: 'cli.failed', severity: 'error', error })
    const failure = error instanceof ClientError ? { code: error.code, message: error.message, status: error.status, retryable: error.retryable,
      errorId, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }
      : { code: 'CLI_ERROR', message: RuntimeMessage.CLI_FAILED_WITH_ERROR_ID, errorId, retryable: false }
    process.stderr.write(JSON.stringify({ ok: false, error: failure }) + '\n')
    process.exitCode = error instanceof ClientError && error.code === 'CLI_USAGE' ? 2 : 1
  })
}
