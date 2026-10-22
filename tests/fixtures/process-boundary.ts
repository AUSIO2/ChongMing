// 生成未捕获错误、启动失败或无法完成的关闭，供真实子进程边界测试使用。
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRegisterBoundary, processRunEntry } from '../../platform/node/process-boundary'

const mode = process.argv[2]
if (mode === 'uncaught' || mode === 'rejection') {
  processRegisterBoundary({ component: 'boundary-fixture' })
  if (mode === 'uncaught') setTimeout(() => {
    // 在异步定时回调中抛出含敏感文本的错误，触发未捕获异常边界。
     throw new Error('private-token-value') }, 0)
  else void Promise.reject(new Error('private-token-value'))
} else {
  const reporter = diagnosticCreateReporter({ component: 'boundary-fixture' })
  processRunEntry({ component: 'boundary-fixture', reporter, timeoutMs: 60, start: async () => {
    // 按模式抛出启动错误，或保持进程存活并返回永不完成的关闭操作。
    if (mode === 'startup') throw new Error('private-token-value')
    setInterval(() => {
      // 保持事件循环活跃，以便测试发送终止信号。
      }, 1000)
    process.stdout.write('ready\n')
    return () => /* 返回永不结束的关闭 Promise，验证关闭期限生效。 */  new Promise<void>(() => {
      // 故意不完成关闭 Promise，模拟挂起的资源释放。
      })
  } })
}
