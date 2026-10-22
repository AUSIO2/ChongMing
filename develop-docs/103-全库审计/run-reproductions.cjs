// 重跑本次自有隔离复现并保存实际输出；不运行产品测试套件或用户数据库。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const cases = [
  ['root-repro.cjs', 'root-repro-output.json'],
  ['repro-domain.cjs', 'repro-domain.out.txt'],
  ['repro-domain-import.cjs', 'repro-domain-import.out.txt'],
  ['repro-experiments.cjs', 'repro-experiments.out.txt'],
  ['runtime-repro.mts', 'runtime-repro-output.txt'],
  ['runtime-grant-repro.mts', 'runtime-grant-repro-output.json'],
  ['runtime-cleanup-repro.cjs', 'runtime-cleanup-repro-output.json'],
  ['reproduce-ui.cjs', 'reproduce-ui-output.jsonl'],
  ['cross-review-ui-runtime-repro.cjs', 'cross-review-ui-runtime-admissibility.jsonl'],
  ['browser-repro.cjs', 'browser-repro-output.json'],
]
const runs = []
for (const [script, output] of cases) {
  const startedAt = new Date().toISOString()
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, script)], {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  })
  fs.writeFileSync(path.join(__dirname, output), result.stdout)
  const stderr = script.replace(/\.(?:cjs|mts)$/, '-stderr.txt')
  fs.writeFileSync(path.join(__dirname, stderr), result.stderr)
  runs.push({ script, output, stderr, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status,
    signal: result.signal, error: result.error ? result.error.message : null,
    scope: '进程内/自有回环HTTP/自有临时夹具；无用户DB/真实模型/真实浏览器；正常退出只说明所记录复现运行完成，不说明产品已修复。' })
  console.log(`${script}: ${result.status === 0 ? 'completed' : 'failed'}`)
}
fs.writeFileSync(path.join(__dirname, 'reproduction-runs.json'), JSON.stringify({ runs }, null, 2) + '\n')
if (runs.some(run => run.exitCode !== 0)) process.exitCode = 1
