import { AppError, ErrorCode, errReadApp } from '../electron/shared/errors'

export interface CliFailure {
  ok: false
  code: string
  msg: string
  failedNode?: string
  mapId?: string
  status?: 'interrupted' | 'error'
}

export function cliReadExitCode(code: string): number {
  if (code === ErrorCode.CLI_USAGE) return 2
  return 1
}

export function cliWriteFailure(
  err: unknown,
  extras?: Partial<CliFailure>,
): CliFailure {
  const app = errReadApp(err)
  const failure: CliFailure = {
    ok: false,
    code: app.code,
    msg: app.msg,
    ...(app.failedNode ? { failedNode: app.failedNode } : {}),
    ...extras,
  }
  console.error(JSON.stringify(failure))
  return failure
}

export function cliThrowUsage(msg: string): never {
  throw new AppError(ErrorCode.CLI_USAGE, msg)
}
