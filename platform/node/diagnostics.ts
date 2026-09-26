import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import type { DiagnosticContext, DiagnosticEvent, DiagnosticReporter } from '../../contracts/diagnostics'

const EVENT_LIMIT = 16 * 1024
const STACK_LIMIT = 40
const FILE_LIMIT = 5 * 1024 * 1024
const ARCHIVE_LIMIT = 3

// 用途：读取代码，并把结构化结果交给调用方。
function diagnosticReadCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = Reflect.getOwnPropertyDescriptor(error, 'code')?.value
  return typeof value === 'string' && /^[A-Z0-9_-]{1,80}$/.test(value) ? value : undefined
}
// 用途：读取诊断，并把结构化结果交给调用方。
function diagnosticReadStack(error: unknown): string[] | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined
  return error.stack.split('\n').slice(1, STACK_LIMIT + 1).map(line => line
    .split(process.cwd()).join('<cwd>')
    .replace(/[/\\](Users|home)[/\\][^/\\\s)]+/g, '/<user>')
    .slice(0, 500))
}
// 用途：读取上下文，并把结构化结果交给调用方。
function diagnosticReadContext(value?: DiagnosticContext): DiagnosticContext | undefined {
  if (!value) return undefined
  const result: DiagnosticContext = {}
  for (const [key, item] of Object.entries(value)) {
    if (!['requestId', 'mapId', 'runId', 'operationId', 'workId', 'phase', 'route', 'reason'].includes(key)) continue
    if (typeof item === 'string') result[key as keyof DiagnosticContext] = /^[A-Za-z0-9_./:-]{1,256}$/.test(item) ? item : '<redacted>'
    else if ((typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean') result[key as keyof DiagnosticContext] = item
  }
  return Object.keys(result).length ? result : undefined
}
// 用途：读取诊断，并把结构化结果交给调用方。
export function diagnosticReadLine(component: string, instanceId: string, event: DiagnosticEvent): { errorId: string; line: string } {
  const errorId = event.errorId ?? randomUUID()
  const record = {
    time: new Date().toISOString(), name: event.name.slice(0, 120), severity: event.severity,
    component: component.slice(0, 80), processInstanceId: instanceId, errorId,
    context: diagnosticReadContext(event.context),
    failure: event.error === undefined ? undefined : {
      type: event.error instanceof Error ? event.error.name.slice(0, 80) : typeof event.error,
      code: diagnosticReadCode(event.error), stack: diagnosticReadStack(event.error),
    },
  }
  let line = JSON.stringify(record)
  if (Buffer.byteLength(line) > EVENT_LIMIT) line = JSON.stringify({ ...record, failure: { ...record.failure, stack: record.failure?.stack?.slice(0, 5) } })
  return { errorId, line: line.slice(0, EVENT_LIMIT - 1) + '\n' }
}
// 用途：处理诊断相关工作，并把结果交给调用方。
function diagnosticRotateFile(filename: string): void {
  if (!existsSync(filename)) return
  const descriptor = openSync(filename, 'r')
  let size: number
  try { size = fstatSync(descriptor).size } finally { closeSync(descriptor) }
  if (size < FILE_LIMIT) return
  rmSync(`${filename}.${ARCHIVE_LIMIT}`, { force: true })
  for (let index = ARCHIVE_LIMIT; index >= 1; index--) {
    const source = index === 1 ? filename : `${filename}.${index - 1}`
    const target = `${filename}.${index}`
    if (existsSync(source)) { rmSync(target, { force: true }); renameSync(source, target) }
  }
}
// 用途：创建诊断，供后续流程使用。
export function diagnosticCreateReporter(input: { component: string; filename?: string; instanceId?: string }): DiagnosticReporter {
  const instanceId = input.instanceId ?? randomUUID()
  let closed = false, writing = false
  return {
    // 用途：记录当前诊断或失败信息。
    report(event) {
      const output = diagnosticReadLine(input.component, instanceId, event)
      if (closed || writing) return output.errorId
      writing = true
      try {
        if (input.filename) { diagnosticRotateFile(input.filename); appendFileSync(input.filename, output.line, { mode: 0o600 }) }
        else writeSync(process.stderr.fd, output.line)
      } catch {
        try { writeSync(process.stderr.fd, diagnosticReadLine('diagnostics', instanceId, { name: 'diagnostics.write.failed', severity: 'error' }).line) } catch { /* no recursive sink */ }
      } finally { writing = false }
      return output.errorId
    },
    // 用途：关闭当前模块并释放占用的资源。
    async close() { closed = true },
  }
}
// 用途：处理诊断相关工作，并把结果交给调用方。
export function diagnosticWriteFatal(component: string, origin: string, error: unknown): void {
  try { writeSync(process.stderr.fd, diagnosticReadLine(component, 'fatal', { name: 'process.fatal', severity: 'fatal', context: { reason: origin }, error }).line) }
  catch { try { writeSync(process.stderr.fd, '{"name":"process.fatal","severity":"fatal"}\n') } catch { /* process exits below */ } }
}
