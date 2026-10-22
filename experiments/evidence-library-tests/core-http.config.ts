// 单独发现真实 HTTP/client 和损坏存储回归，不改变原独立业务测试的发现范围。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node', globals: false, maxWorkers: 1,
    include: ['experiments/evidence-library-tests/core-http.spec.ts'],
    testTimeout: 30_000, hookTimeout: 60_000,
  },
})
