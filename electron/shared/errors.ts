/** 应用错误码 — 字符串枚举，便于 IPC / 日志。 */
export enum ErrorCode {
  INTERNAL_ERROR = 'INTERNAL_ERROR',

  CONFIG_API_KEY_MISSING = 'CONFIG_API_KEY_MISSING',

  NEWS_NOT_FOUND = 'NEWS_NOT_FOUND',

  GRAPH_RUN_NOT_FOUND = 'GRAPH_RUN_NOT_FOUND',
  GRAPH_NO_PENDING_INTERRUPT = 'GRAPH_NO_PENDING_INTERRUPT',
  GRAPH_EXECUTION_FAILED = 'GRAPH_EXECUTION_FAILED',

  CLAIM_NOT_FOUND = 'CLAIM_NOT_FOUND',

  MAP_API_NOT_INSTALLED = 'MAP_API_NOT_INSTALLED',
  MAP_NODE_NOT_FOUND = 'MAP_NODE_NOT_FOUND',
  MAP_CANNOT_ADD_SUBAGENT = 'MAP_CANNOT_ADD_SUBAGENT',
  MAP_CANNOT_EDIT_NODE = 'MAP_CANNOT_EDIT_NODE',
  MAP_CANNOT_REMOVE_NODE = 'MAP_CANNOT_REMOVE_NODE',
}

const APP_ERROR_PREFIX = '__APP_ERROR__:'

export interface AppErrorExtras {
  failedNode?: string
  cause?: unknown
}

/** 业务与图运行统一异常：code + msg，可选 failedNode。 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly msg: string
  readonly failedNode?: string
  readonly cause?: unknown

  constructor(code: ErrorCode, msg: string, extras?: AppErrorExtras) {
    super(msg)
    this.name = 'AppError'
    this.code = code
    this.msg = msg
    this.failedNode = extras?.failedNode
    this.cause = extras?.cause
  }
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.values(ErrorCode).includes(value as ErrorCode)
}

function readableMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) {
      return `${error.message}: ${cause.message}`
    }
    return error.message || error.name || 'Unknown error'
  }
  return String(error)
}

/**
 * 将任意错误规范为 AppError。
 * 已是 AppError 时保留 code/msg，可合并 failedNode 等 extras。
 */
export function normalizeError(
  error: unknown,
  fallbackCode: ErrorCode = ErrorCode.INTERNAL_ERROR,
  extras?: AppErrorExtras,
): AppError {
  if (error instanceof AppError) {
    if (!extras?.failedNode || error.failedNode) {
      return error
    }
    return new AppError(error.code, error.msg, {
      failedNode: extras.failedNode,
      cause: error.cause ?? error,
    })
  }

  return new AppError(fallbackCode, readableMessage(error), {
    failedNode: extras?.failedNode,
    cause: extras?.cause ?? error,
  })
}

/** IPC invoke 序列化：Electron 只保证 message 跨进程。 */
export function serializeAppError(error: AppError): Error {
  const payload = {
    code: error.code,
    msg: error.msg,
    ...(error.failedNode ? { failedNode: error.failedNode } : {}),
  }
  const err = new Error(`${APP_ERROR_PREFIX}${JSON.stringify(payload)}`)
  err.name = 'AppError'
  return err
}

function parseSerializedPayload(message: string): AppError | null {
  const start = message.indexOf(APP_ERROR_PREFIX)
  if (start === -1) return null

  const jsonText = message.slice(start + APP_ERROR_PREFIX.length)
  // Electron 可能在尾部追加其它文案，取第一个完整 JSON 对象
  const brace = jsonText.indexOf('{')
  if (brace === -1) return null

  let depth = 0
  let end = -1
  for (let i = brace; i < jsonText.length; i++) {
    const ch = jsonText[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return null

  try {
    const parsed = JSON.parse(jsonText.slice(brace, end + 1)) as {
      code?: unknown
      msg?: unknown
      failedNode?: unknown
    }
    if (isErrorCode(parsed.code) && typeof parsed.msg === 'string') {
      return new AppError(parsed.code, parsed.msg, {
        failedNode: typeof parsed.failedNode === 'string' ? parsed.failedNode : undefined,
      })
    }
  } catch {
    return null
  }
  return null
}

/** 从 IPC reject / 本地 throw 还原 AppError。 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error

  const message = error instanceof Error ? error.message : String(error)
  const parsed = parseSerializedPayload(message)
  if (parsed) return parsed

  return normalizeError(error)
}

/** 将 unknown 错误规范为可读字符串。 */
export function errorMessage(error: unknown): string {
  return toAppError(error).msg
}
