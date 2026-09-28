// 生成脱敏且有大小限制的结构化诊断，并提供同步写入、文件轮转和致命故障兜底。
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import type { DiagnosticContext, DiagnosticEvent, DiagnosticReporter } from '../../contracts/diagnostics'

const EVENT_LIMIT = 16 * 1024
const STACK_LIMIT = 40
const FILE_LIMIT = 5 * 1024 * 1024
const ARCHIVE_LIMIT = 3

function diagnosticReadCode(/* 未知来源的错误值，仅检查其自有 code 描述符而不执行 getter。 */ error: unknown): string | undefined {
  // 只读取错误自身的普通 code 值并限制其格式，避免访问继承属性或执行 getter。
  if (!error || typeof error !== 'object') return undefined
  const value = Reflect.getOwnPropertyDescriptor(error, 'code')?.value
  return typeof value === 'string' && /^[A-Z0-9_-]{1,80}$/.test(value) ? value : undefined
}
function diagnosticReadStack(/* 待提取栈的未知错误值，仅处理具有字符串栈的 Error 实例。 */ error: unknown): string[] | undefined {
  // 提取有限层数的错误栈，去掉可能含敏感文本的首行并脱敏路径。
  if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined
  return error.stack.split('\n').slice(1, STACK_LIMIT + 1).map(/* 去除错误首行后的一条栈帧文本，需脱敏目录并限制长度。 */ line => /* 隐藏工作目录和用户目录名称，并限制单个栈帧长度。 */  line
    .split(process.cwd()).join('<cwd>')
    .replace(/[/\\](Users|home)[/\\][^/\\\s)]+/g, '/<user>')
    .slice(0, 500))
}
function diagnosticReadContext(/* 可选诊断上下文，不信任字段或字符串内容，按白名单筛除。 */ value?: DiagnosticContext): DiagnosticContext | undefined {
  // 只保留允许的上下文键和值格式，其他字符串以脱敏标记替代。
  if (!value) return undefined
  const result: DiagnosticContext = {}
  for (const [key, item] of Object.entries(value)) {
    if (!['requestId', 'mapId', 'runId', 'operationId', 'workId', 'phase', 'route', 'reason'].includes(key)) continue
    if (typeof item === 'string') result[key as keyof DiagnosticContext] = /^[A-Za-z0-9_./:-]{1,256}$/.test(item) ? item : '<redacted>'
    else if ((typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean') result[key as keyof DiagnosticContext] = item
  }
  return Object.keys(result).length ? result : undefined
}
export function diagnosticReadLine(/* 产生事件的组件标签，写入日志前限制长度。 */ component: string, /* 本次输出器或进程实例的关联编号，用于区分不同运行实例。 */ instanceId: string, /* 待序列化的诊断事件，错误正文不直接写出，上下文和栈先脱敏。 */ event: DiagnosticEvent): { errorId: string; line: string } {
  // 为事件分配诊断编号，组装脱敏上下文及错误栈并限制输出行大小。
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
function diagnosticRotateFile(/* 当前日志文件路径，轮转仅操作该文件及其编号归档。 */ filename: string): void {
  // 日志达到阈值时按编号轮转，并最多保留三个历史文件。
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
export function diagnosticCreateReporter(/* 输出组件和可选日志文件、实例编号；未给文件时写标准错误，未给实例编号时新建 UUID。 */ input: { component: string; filename?: string; instanceId?: string }): DiagnosticReporter {
  // 创建属于单个进程实例的诊断输出器，以重入保护避免写日志失败引发递归日志。
  const instanceId = input.instanceId ?? randomUUID()
  let closed = false, writing = false
  return {
    report(/* 调用方上报的诊断输入，先生成脱敏行，再按输出器生命周期决定是否写入。 */ event) {
      // 同步写入脱敏事件并返回诊断编号，输出失败时尝试最小兜底日志。
      const output = diagnosticReadLine(input.component, instanceId, event)
      if (closed || writing) return output.errorId
      writing = true
      try {
        if (input.filename) { diagnosticRotateFile(input.filename); appendFileSync(input.filename, output.line, { mode: 0o600 }) }
        else writeSync(process.stderr.fd, output.line)
      } catch {
        try { writeSync(process.stderr.fd, diagnosticReadLine('diagnostics', instanceId, { name: 'diagnostics.write.failed', severity: 'error' }).line) } catch { /* 兜底输出失败不再递归写日志。 */ }
      } finally { writing = false }
      return output.errorId
    },
    async close() {
      // 停止接受后续日志写入，已生成的诊断编号仍可返回调用方。
       closed = true },
  }
}
export function diagnosticWriteFatal(/* 致命故障所属组件，进入同步兜底日志。 */ component: string, /* 触发致命边界的来源标签，例如未捕获异常或未处理拒绝。 */ origin: string, /* 即将导致进程退出的原始失败值，仍通过脱敏编码处理。 */ error: unknown): void {
  // 同步写入致命错误，主输出失败时再次尝试最小 JSON，避免依赖异步清理。
  try { writeSync(process.stderr.fd, diagnosticReadLine(component, 'fatal', { name: 'process.fatal', severity: 'fatal', context: { reason: origin }, error }).line) }
  catch { try { writeSync(process.stderr.fd, '{"name":"process.fatal","severity":"fatal"}\n') } catch { /* 输出失败交回致命错误边界继续退出。 */ } }
}
