// 为整套测试托管一个隔离消息代理，并传递中断信号、退出码及清理责任。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { rabbitCreateBroker } from './backend/fixtures/rabbitmq'

async function testRunSuite(): Promise<void> {
  // 创建套件级消息代理，启动 Vitest 并转发退出信号，测试结束后始终清理代理。
  const broker = await rabbitCreateBroker()
  try {
    const child = spawn(process.execPath, [path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, CHONGMING_TEST_BROKER_FILE: broker.file },
    })
    const interrupt = () => {
      // 把用户中断转发给测试子进程，使其有机会执行测试清理。
      child.kill('SIGINT') }
    const terminate = () => {
      // 把终止请求转发给测试子进程，避免只结束外层包装器。
      child.kill('SIGTERM') }
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        // 等待测试子进程创建失败或退出，并保存退出码及终止信号。
        child.once('error', reject); child.once('exit', (code, signal) => /* 把子进程的退出信息交给包装器计算最终退出码。 */ resolve({ code, signal }))
      })
      process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 1)
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate) }
  } finally { await broker.close() }
}

testRunSuite().catch(() => {
  // 报告代理初始化或清理失败，并让套件以失败状态退出。
  console.error('Tests could not initialize or close the isolated RabbitMQ broker; check Docker or CHONGMING_TEST_BROKER_FILE')
  process.exitCode = 1
})
