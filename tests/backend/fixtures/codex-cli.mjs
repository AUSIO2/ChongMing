#!/usr/bin/env node
// 仅测试用的真实子进程：读取stdin/参数并写受控结果，绝不调用任何模型。
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-config.json')
const config = JSON.parse(await readFile(configPath, 'utf8'))
const args = process.argv.slice(2)
const outputPath = args[args.indexOf('-o') + 1]
const schemaPath = args[args.indexOf('--output-schema') + 1]
let input = ''
for await (const chunk of process.stdin) input += chunk.toString()
await writeFile(config.tracePath, JSON.stringify({ args, input, cwd: process.cwd(), envNames: Object.keys(process.env),
  modelKeyDigest: process.env.CHONGMING_MODEL_API_KEY ? createHash('sha256').update(process.env.CHONGMING_MODEL_API_KEY).digest('hex') : null,
  codexHome: process.env.CODEX_HOME,
  schema: JSON.parse(await readFile(schemaPath, 'utf8')) }), { mode: 0o600 })
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-session' }) + '\n')
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n')
if (config.mode === 'hang') {
  const timer = setInterval(() => { /* 只有取消测试会进入，保持真实子进程直到宿主终止。 */ }, 1000)
  process.on('SIGTERM', () => {
    // 故意推迟退出，证明执行器等待实际close而非发kill就返回。
    setTimeout(async () => {
      // 退出前留下确定标记，测试只读此自有文件。
      await writeFile(config.tracePath + '.closed', 'closed')
      clearInterval(timer)
      process.exit(0)
    }, 40)
  })
  await new Promise(() => { /* 由取消信号结束进程，不推进其它工作。 */ })
} else if (config.mode === 'exit') {
  process.stderr.write('Controlled fake Codex failure\n')
  process.exitCode = 7
} else {
  const output = config.mode === 'invalid' ? 'This is not a structured proposal'
    : JSON.stringify({ proposalJson: JSON.stringify(config.proposal) })
  await writeFile(outputPath, output, { mode: 0o600 })
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n')
}
