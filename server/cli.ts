import { ErrorCode, errReadApp } from '../electron/shared/errors'
import { serverBootstrap, serverShutdown } from './bootstrap'
import {
  cliReadContentArg,
  cmdCreate,
  cmdList,
  cmdRun,
  cmdStatus,
} from './commands'
import { cliReadExitCode, cliThrowUsage, cliWriteFailure } from './errors'

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx < 0) return undefined
  const value = args[idx + 1]
  if (value === undefined || value.startsWith('-')) {
    cliThrowUsage(`missing value for ${name}`)
  }
  args.splice(idx, 2)
  return value
}

async function dispatch(argv: string[]): Promise<void> {
  const args = [...argv]
  const cmd = args.shift()
  if (!cmd) {
    cliThrowUsage('usage: headless <list|create|run|status> ...')
  }

  switch (cmd) {
    case 'list': {
      const workspace = readFlag(args, '--workspace')
      if (args.length) cliThrowUsage(`unexpected args: ${args.join(' ')}`)
      await cmdList(workspace)
      return
    }
    case 'create': {
      const kind = readFlag(args, '--kind') as 'source' | 'news' | 'claim' | undefined
      if (kind !== 'source' && kind !== 'news' && kind !== 'claim') {
        cliThrowUsage('create requires --kind source|news|claim')
      }
      const mapId = readFlag(args, '--map')
      const workspaceId = readFlag(args, '--workspace')
      const uri = readFlag(args, '--uri')
      const label = readFlag(args, '--label')
      const sourceKindRaw = readFlag(args, '--source-kind')
      const content = cliReadContentArg(readFlag(args, '--content'))
      if (args.length) cliThrowUsage(`unexpected args: ${args.join(' ')}`)
      const sourceKind =
        sourceKindRaw === 'file' || sourceKindRaw === 'url'
          ? sourceKindRaw
          : undefined
      await cmdCreate({
        kind,
        mapId,
        workspaceId,
        uri,
        label,
        sourceKind,
        content,
      })
      return
    }
    case 'run': {
      const mapId = args.shift()
      if (!mapId) cliThrowUsage('run requires <mapId>')
      const from = readFlag(args, '--from')
      const to = readFlag(args, '--to')
      const scope = readFlag(args, '--scope')
      if (args.length) cliThrowUsage(`unexpected args: ${args.join(' ')}`)
      await cmdRun({ mapId, from, to, scope })
      return
    }
    case 'status': {
      const mapId = args.shift()
      if (!mapId) cliThrowUsage('status requires <mapId>')
      if (args.length) cliThrowUsage(`unexpected args: ${args.join(' ')}`)
      await cmdStatus(mapId)
      return
    }
    default:
      cliThrowUsage(`unknown command: ${cmd}`)
  }
}

async function main(): Promise<void> {
  let code = 0
  try {
    const argv = process.argv.slice(2)
    if (!argv[0]) {
      cliThrowUsage('usage: headless <list|create|run|status> ...')
    }
    await serverBootstrap()
    await dispatch(argv)
  } catch (e) {
    const app = errReadApp(e)
    const extras =
      app.code === ErrorCode.CLI_RUN_INTERRUPTED
        ? { status: 'interrupted' as const }
        : undefined
    cliWriteFailure(e, extras)
    code = cliReadExitCode(app.code)
  } finally {
    try {
      await serverShutdown()
    } catch (shutdownErr) {
      // 未 bootstrap 时 shutdown 也安全；失败再记一次
      if (code === 0) {
        cliWriteFailure(shutdownErr)
        code = 1
      }
    }
  }
  process.exit(code)
}


void main()
