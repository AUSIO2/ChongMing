// 配置 Node 环境下的 Vitest 测试发现范围，并要求显式导入测试 API。
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // 浏览器用例由 Playwright 执行，保留 Vitest 原有的依赖/产物排除规则。
    exclude: [...configDefaults.exclude, 'tests/browser/**'],
    globals: false,
    // 真实 Mongo、RabbitMQ 与 DSH 套件会启动子进程；限制文件并发，避免资源争用制造假超时。
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
