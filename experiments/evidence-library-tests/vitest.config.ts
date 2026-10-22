// 独立发现功能用例，不启动项目整套 RabbitMQ 测试入口。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node', globals: false, maxWorkers: 1,
    include: ['experiments/evidence-library-tests/functional.spec.ts', 'experiments/evidence-library-tests/business-boundaries.spec.ts'],
    testTimeout: 30_000, hookTimeout: 60_000,
  },
})
