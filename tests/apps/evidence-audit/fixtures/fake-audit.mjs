// 仅供adapter测试的协议进程：按输入模式制造正常、失败及生命周期场景。
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const inputPath = process.argv[3]
const input = JSON.parse(readFileSync(inputPath, 'utf8'))
const mode = input.fixtureMode ?? 'pass'
if (mode === 'hang') {
  process.on('SIGTERM', () => { /* 故意忽略正常终止，验证adapter随后强制回收。 */ })
  setInterval(() => { /* 保持进程活跃，等待adapter的取消或超时。 */ }, 100)
} else if (mode === 'huge') {
  process.stdout.write('x'.repeat(33 * 1024 * 1024))
} else if (mode === 'badjson') {
  process.stdout.write('{truncated')
} else if (mode === 'invalid') {
  process.stdout.write(JSON.stringify({ protocolVersion: 1, status: 'invalid', error: { code: 'INPUT_INVALID', message: 'Invalid fixture.' } }))
  process.exitCode = 2
} else {
  const findings = mode === 'fail' ? [{ code: 'BROKEN_REFERENCE', severity: 'error', message: 'Missing fixture node.' }]
    : mode === 'warning' ? [{ code: 'PENDING_CLAIM', severity: 'warning', message: 'Pending fixture claim.' }] : []
  const summary = { nodeCount: input.nodes?.length ?? 0, edgeCount: input.edges?.length ?? 0,
    errorCount: mode === 'fail' ? 1 : 0, warningCount: mode === 'warning' ? 1 : 0,
    claimCount: 0, pendingClaimCount: 0, unsupportedNodeCount: 0, externalReferenceCount: 0 }
  const markdown = mode === 'inspect' ? JSON.stringify({ inputPath, directoryMode: statSync(path.dirname(inputPath)).mode & 0o777,
    fileMode: statSync(inputPath).mode & 0o777, args: process.argv.slice(2), env: process.env, input }) : '# 仓颉协议测试\n'
  process.stdout.write(JSON.stringify({ protocolVersion: 1, status: mode === 'fail' ? 'fail' : mode === 'warning' ? 'warning' : 'pass', summary, findings, markdown }))
  process.exitCode = mode === 'fail' || mode === 'mismatch' ? 1 : 0
}
