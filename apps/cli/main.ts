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
process.stdout.on('error', error => {
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

// 用途：处理当前模块相关工作，并把结果交给调用方。
function cliThrowUsage(message: string): never {
  throw new ClientError({ status: 0, code: 'CLI_USAGE', message, retryable: false })
}
// 用途：读取字节，并把结构化结果交给调用方。
async function cliReadBytes(file: string): Promise<Uint8Array> {
  if ((await stat(file)).size > CLIENT_FILE_LIMIT) cliThrowUsage('Input exceeds 64 MiB')
  const bytes = await readFile(file)
  if (bytes.byteLength > CLIENT_FILE_LIMIT) cliThrowUsage('Input exceeds 64 MiB')
  return bytes
}
// 用途：读取输入，并把结构化结果交给调用方。
async function cliReadInput(file?: string): Promise<Record<string, unknown>> {
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
// 用途：读取标识，并把结构化结果交给调用方。
function cliReadId(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) cliThrowUsage('A UUID is required')
  return value
}

// 用途：执行当前模块流程，并返回执行结果。
export async function cliRun(argv: string[]): Promise<void> {
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
  if (Object.keys(values).some(key => !['url', 'token-file', ...allowed[command]].includes(key))) cliThrowUsage('Option does not belong to this command')
  if (positionals.length !== (command === 'upload' ? 1 : command === 'download' ? 3 : 2)) cliThrowUsage('Unexpected or missing positional argument')
  if (command === 'read' && !CLIENT_QUERY_METHODS.some(item => item === method)) cliThrowUsage('Unknown query method')
  if (command === 'dispatch' && !CLIENT_COMMAND_METHODS.some(item => item === method)) cliThrowUsage('Unknown command method')
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
  const interrupt = () => stop.abort()
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  try {
    if (command === 'watch') {
      await client.watch(method, event => { process.stdout.write(JSON.stringify(event) + '\n') }, stop.signal)
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
  cliRun(process.argv.slice(2)).catch(error => {
    const errorId = error instanceof ClientError ? error.errorId : reporter.report({ name: 'cli.failed', severity: 'error', error })
    const failure = error instanceof ClientError ? { code: error.code, message: error.message, status: error.status, retryable: error.retryable,
      errorId, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }
      : { code: 'CLI_ERROR', message: RuntimeMessage.CLI_FAILED_WITH_ERROR_ID, errorId, retryable: false }
    process.stderr.write(JSON.stringify({ ok: false, error: failure }) + '\n')
    process.exitCode = error instanceof ClientError && error.code === 'CLI_USAGE' ? 2 : 1
  })
}
