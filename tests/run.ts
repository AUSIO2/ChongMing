import { spawn } from 'node:child_process'
import path from 'node:path'
import { rabbitCreateBroker } from './backend/fixtures/rabbitmq'

async function testRunSuite(): Promise<void> {
  const broker = await rabbitCreateBroker()
  try {
    const child = spawn(process.execPath, [path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, CHONGMING_TEST_BROKER_FILE: broker.file },
    })
    const interrupt = () => { child.kill('SIGINT') }
    const terminate = () => { child.kill('SIGTERM') }
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }))
      })
      process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 1)
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate) }
  } finally { await broker.close() }
}

testRunSuite().catch(() => {
  console.error('Tests could not initialize or close the isolated RabbitMQ broker; check Docker or CHONGMING_TEST_BROKER_FILE')
  process.exitCode = 1
})
