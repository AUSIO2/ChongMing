// 仓颉模块的专用验收入口：显式要求已经构建真实二进制，不影响普通Node回归的环境要求。
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    environment: 'node',
    include: ['tests/apps/evidence-audit/*.spec.ts'],
    globals: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
