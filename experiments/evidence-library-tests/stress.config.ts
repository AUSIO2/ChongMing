// 压测单独发现、串行执行；不会由项目默认功能测试意外启动。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node', globals: false, maxWorkers: 1,
    include: ['experiments/evidence-library-tests/stress.spec.ts'],
    hookTimeout: 30_000,
  },
})
