// 单独执行出处关系的真实 Mongo/HTTP 验收，不改原核心和完整业务套件的发现范围。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node', globals: false, maxWorkers: 1,
    include: ['experiments/evidence-library-tests/relations.spec.ts'],
    testTimeout: 30_000, hookTimeout: 60_000,
  },
})
