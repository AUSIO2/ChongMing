// 配置 Node 环境下的 Vitest 测试发现范围，并要求显式导入测试 API。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
  },
})
