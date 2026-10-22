// 独立执行跨 Map 显式库选材和使用追溯验收，不替换原证据库业务套件。
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { environment: 'node', globals: false, maxWorkers: 1,
  include: ['experiments/evidence-library-tests/usage.spec.ts'], testTimeout: 30_000, hookTimeout: 60_000 } })
