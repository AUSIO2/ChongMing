// 托管仓颉图审计进程：隔离输入与凭据，限制资源并验证结果协议。
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const AUDIT_INPUT_LIMIT_BYTES = 10 * 1024 * 1024
const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024
const DEFAULT_BINARY = fileURLToPath(new URL('../evidence-audit-cj/bin/evidence-audit', import.meta.url))

export enum AuditMessage {
  USAGE = 'Provide exactly one --input or --map-id and valid options; use --help.',
  INPUT_INVALID = 'Audit input must be valid UTF-8 JSON containing a graph, not a failed response or export bundle.',
  INPUT_TOO_LARGE = 'Audit input exceeds the 10 MiB limit.',
  INPUT_READ_FAILED = 'Could not read the audit input file.',
  TOKEN_REQUIRED = 'API mode requires a user token in --token-file or CHONGMING_USER_TOKEN.',
  API_FAILED = 'Could not read the requested graph through the public API.',
  BINARY_FAILED = 'Could not start the Cangjie audit binary; build it or set CHONGMING_CANGJIE_AUDIT_BIN.',
  PROCESS_FAILED = 'The Cangjie audit process exited unexpectedly.',
  PROCESS_TIMEOUT = 'The Cangjie audit process exceeded its execution deadline.',
  CANCELLED = 'Audit execution was cancelled.',
  OUTPUT_TOO_LARGE = 'The Cangjie audit process exceeded the 32 MiB output limit.',
  PROTOCOL_INVALID = 'The Cangjie audit result or exit code does not match protocol version 1.',
  TEMP_FAILED = 'Could not create or clean up the private audit input directory.',
  OUTPUT_FAILED = 'Could not create the report file; existing files are never overwritten.',
  FAILED = 'Audit execution failed.',
}

export class AuditError extends Error {
  code: string
  readonly exitCode: 2 | 3
  constructor(/* 稳定诊断编号，不包含输入内容或凭据。 */ code: string,
    /* 对外可显示的受控错误文案。 */ message: AuditMessage,
    /* 输入错误为2，进程或I/O故障为3。 */ exitCode: 2 | 3) {
    // 保存命令行能够安全输出的错误分类。
    super(message); this.name = 'AuditError'; this.code = code; this.exitCode = exitCode
  }
}

export interface AuditFinding {
  code: string
  severity: 'error' | 'warning'
  message: string
  nodeId?: string
  edgeId?: string
  path?: string
}
export interface AuditSummary {
  nodeCount: number
  edgeCount: number
  errorCount: number
  warningCount: number
  claimCount: number
  pendingClaimCount: number
  unsupportedNodeCount: number
  externalReferenceCount: number
}
export type AuditResult = {
  protocolVersion: 1
  status: 'pass' | 'warning' | 'fail'
  summary: AuditSummary
  findings: AuditFinding[]
  markdown: string
} | { protocolVersion: 1; status: 'invalid'; error: { code: string; message: string; path?: string } }

interface AuditProcessOptions {
  /** 已解析的本地输入或公共API快照；不修改原对象。 */
  input: unknown
  /** 省略时使用环境配置或模块构建路径。 */
  binaryPath?: string
  /** 调用方取消本次读取与进程；进程关闭后才结束等待。 */
  signal?: AbortSignal
  /** 从spawn开始计时，默认30000毫秒；到期终止并强制回收。 */
  timeoutMs?: number
}

export function auditIsObject(/* JSON边界中尚未收窄的值。 */ value: unknown): value is Record<string, unknown> {
  // 只接受对象映射，排除null和数组。
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function auditNormalizeInput(/* 裸图或现有CLI的成功响应对象。 */ value: unknown): Record<string, unknown> {
  // 解开唯一受支持的响应信封，拒绝失败响应和v4导出包；图字段由仓颉验证。
  if (!auditIsObject(value)) throw new AuditError('AUDIT_INPUT_INVALID', AuditMessage.INPUT_INVALID, 2)
  if ('ok' in value) {
    if (value.ok !== true || !auditIsObject(value.data)) throw new AuditError('AUDIT_INPUT_INVALID', AuditMessage.INPUT_INVALID, 2)
    value = value.data
  }
  if (!auditIsObject(value) || 'format' in value) throw new AuditError('AUDIT_INPUT_INVALID', AuditMessage.INPUT_INVALID, 2)
  return value
}

export async function auditRunCangjie(/* 本次独占进程的输入、取消与执行选项。 */ options: AuditProcessOptions): Promise<AuditResult> {
  // 创建私有临时图文件，执行并核对仓颉结果，最后清理本次全部输入资源。
  if (options.signal?.aborted) throw new AuditError('AUDIT_CANCELLED', AuditMessage.CANCELLED, 3)
  const input = JSON.stringify(auditNormalizeInput(options.input))
  if (Buffer.byteLength(input) > AUDIT_INPUT_LIMIT_BYTES) throw new AuditError('AUDIT_INPUT_TOO_LARGE', AuditMessage.INPUT_TOO_LARGE, 2)
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AuditError('AUDIT_USAGE', AuditMessage.USAGE, 2)
  let directory: string
  try { directory = await mkdtemp(path.join(tmpdir(), 'chongming-evidence-audit-')) }
  catch { throw new AuditError('AUDIT_TEMP_FAILED', AuditMessage.TEMP_FAILED, 3) }
  let primaryFailure: unknown
  try {
    await chmod(directory, 0o700)
    const inputPath = path.join(directory, 'snapshot.json')
    await writeFile(inputPath, input, { mode: 0o600, flag: 'wx' })
    const reply = await runProcess({ binaryPath: options.binaryPath ?? process.env.CHONGMING_CANGJIE_AUDIT_BIN ?? DEFAULT_BINARY,
      inputPath, signal: options.signal, timeoutMs })
    return parseReply(reply.stdout, reply.exitCode)
  } catch (error) {
    // 保留输入、协议或进程的主要错误，使清理失败不会覆盖它。
    primaryFailure = error
    if (error instanceof AuditError) throw error
    throw new AuditError('AUDIT_TEMP_FAILED', AuditMessage.TEMP_FAILED, 3)
  } finally {
    try { await rm(directory, { recursive: true, force: true }) }
    catch {
      // 双重失败保留主要分类，并附可定位的清理状态，不输出本机路径。
      if (primaryFailure instanceof AuditError) primaryFailure.code += '_CLEANUP_FAILED'
      else throw new AuditError('AUDIT_TEMP_FAILED', AuditMessage.TEMP_FAILED, 3)
    }
  }
}

function childEnvironment(): NodeJS.ProcessEnv {
  // 仅转交仓颉加载器需要的环境，不把用户token、模型密钥或Node注入设置交给子进程。
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'CANGJIE_HOME', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'SystemRoot', 'WINDIR']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  }
  return environment
}

async function runProcess(/* 已持久化的私有输入及子进程生命周期配置。 */ options: {
  binaryPath: string; inputPath: string; signal?: AbortSignal; timeoutMs: number
}): Promise<{ stdout: Buffer; exitCode: number }> {
  // 等到子进程和输出管道关闭才交还结果；超时、取消和输出超限均先终止进程。
  if (options.signal?.aborted) throw new AuditError('AUDIT_CANCELLED', AuditMessage.CANCELLED, 3)
  if (!options.binaryPath.trim() || options.binaryPath.includes('\0')) throw new AuditError('AUDIT_BINARY_FAILED', AuditMessage.BINARY_FAILED, 3)
  return new Promise((/* 完整结果或已回收进程后的错误。 */ resolve, /* 进程创建、协议前置或限额错误。 */ reject) => {
    // 当前Promise独占timer、listener、输出缓冲和子进程，close统一释放。
    const child = spawn(options.binaryPath, ['--input', options.inputPath], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment() })
    const chunks: Buffer[] = []
    let bytes = 0, failure: AuditError | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
    function stop(/* 首个触发关闭的稳定错误。 */ error: AuditError): void {
      // 只保留首个错误，先正常终止，短暂排空后强制回收忽略信号的进程。
      if (failure) return
      failure = error
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        // SIGTERM宽限期结束后强制关闭仍活跃的仓颉进程。
        child.kill('SIGKILL')
      }, 200)
    }
    const timer = setTimeout(() => /* 从启动开始限制单次仓颉执行时间。 */ stop(new AuditError('AUDIT_TIMEOUT', AuditMessage.PROCESS_TIMEOUT, 3)), options.timeoutMs)
    const abort = () => /* 将调用方取消转换为有界进程回收。 */ stop(new AuditError('AUDIT_CANCELLED', AuditMessage.CANCELLED, 3))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout.on('data', (/* 单块标准输出，限制累计字节后才保存。 */ chunk: Buffer) => {
      // stdout与stderr共用输出预算，避免异常二进制无限占用内存。
      bytes += chunk.length
      if (bytes > OUTPUT_LIMIT_BYTES) stop(new AuditError('AUDIT_OUTPUT_TOO_LARGE', AuditMessage.OUTPUT_TOO_LARGE, 3))
      else if (!failure) chunks.push(chunk)
    })
    child.stderr.on('data', (/* 只计字节不转交内容的诊断输出。 */ chunk: Buffer) => {
      // 不公开子进程stderr，以免本机路径或输入正文进入命令行错误。
      bytes += chunk.length
      if (bytes > OUTPUT_LIMIT_BYTES) stop(new AuditError('AUDIT_OUTPUT_TOO_LARGE', AuditMessage.OUTPUT_TOO_LARGE, 3))
    })
    child.once('error', () => {
      // spawn失败后仍等待close释放管道，但不暴露原生异常中的路径。
      failure ??= new AuditError('AUDIT_BINARY_FAILED', AuditMessage.BINARY_FAILED, 3)
    })
    child.once('close', (/* 仓颉实际退出码，信号退出时为null。 */ code, /* 信号终止的标记。 */ signal) => {
      // 解除本次全部计时器与取消监听，然后返回协议数据或受控失败。
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (signal || code === null) reject(new AuditError('AUDIT_PROCESS_FAILED', AuditMessage.PROCESS_FAILED, 3))
      else resolve({ stdout: Buffer.concat(chunks), exitCode: code })
    })
  })
}

function parseReply(/* 仓颉标准输出的有界完整字节。 */ bytes: Buffer, /* 同一进程的实际退出码。 */ exitCode: number): AuditResult {
  // 在真正跨语言的边界核对字段、计数和退出状态，拒绝截断或伪成功结果。
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new AuditError('AUDIT_PROTOCOL_INVALID', AuditMessage.PROTOCOL_INVALID, 3) }
  const invalid = (): never => {
    // 将所有不一致响应收敛为同一种协议失败，不回显不可信输出。
    throw new AuditError('AUDIT_PROTOCOL_INVALID', AuditMessage.PROTOCOL_INVALID, 3)
  }
  if (!auditIsObject(value) || value.protocolVersion !== 1) return invalid()
  if (value.status === 'invalid') {
    if (exitCode !== 2 || !auditIsObject(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') return invalid()
    if (value.error.path !== undefined && typeof value.error.path !== 'string') return invalid()
    return { protocolVersion: 1, status: 'invalid', error: { code: value.error.code, message: value.error.message,
      ...(typeof value.error.path === 'string' ? { path: value.error.path } : {}) } }
  }
  if ((value.status !== 'pass' && value.status !== 'warning' && value.status !== 'fail') || !auditIsObject(value.summary) || !Array.isArray(value.findings) || typeof value.markdown !== 'string') return invalid()
  const keys = ['nodeCount', 'edgeCount', 'errorCount', 'warningCount', 'claimCount', 'pendingClaimCount', 'unsupportedNodeCount', 'externalReferenceCount'] as const
  for (const key of keys) if (!Number.isSafeInteger(value.summary[key]) || Number(value.summary[key]) < 0) return invalid()
  const findings: AuditFinding[] = []
  for (const finding of value.findings) {
    if (!auditIsObject(finding) || typeof finding.code !== 'string' || (finding.severity !== 'error' && finding.severity !== 'warning') || typeof finding.message !== 'string') return invalid()
    for (const key of ['nodeId', 'edgeId', 'path']) if (finding[key] !== undefined && typeof finding[key] !== 'string') return invalid()
    findings.push({ code: finding.code, severity: finding.severity, message: finding.message,
      ...(typeof finding.nodeId === 'string' ? { nodeId: finding.nodeId } : {}),
      ...(typeof finding.edgeId === 'string' ? { edgeId: finding.edgeId } : {}),
      ...(typeof finding.path === 'string' ? { path: finding.path } : {}) })
  }
  const errors = findings.filter((/* 当前发现项。 */ finding) => /* 统计结构错误。 */ finding.severity === 'error').length
  const warnings = findings.length - errors
  const status = errors ? 'fail' : warnings ? 'warning' : 'pass'
  if (value.status !== status || value.summary.errorCount !== errors || value.summary.warningCount !== warnings || exitCode !== (errors ? 1 : 0)) return invalid()
  const counts = value.summary
  const summary: AuditSummary = { nodeCount: Number(counts.nodeCount), edgeCount: Number(counts.edgeCount),
    errorCount: errors, warningCount: warnings, claimCount: Number(counts.claimCount), pendingClaimCount: Number(counts.pendingClaimCount),
    unsupportedNodeCount: Number(counts.unsupportedNodeCount), externalReferenceCount: Number(counts.externalReferenceCount) }
  return { protocolVersion: 1, status, summary, findings, markdown: value.markdown }
}
