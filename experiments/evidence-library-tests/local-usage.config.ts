// 独立发现无Mongo证据库的SQLite写入拒绝用例，不依赖核查旧payload字段。
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { environment: 'node', globals: false, maxWorkers: 1,
  include: ['experiments/evidence-library-tests/local-usage.spec.ts'], testTimeout: 20_000, hookTimeout: 30_000 } })
