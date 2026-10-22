// 性能用例独立发现；默认只执行短校准，正式容量/长时运行由固定配置显式许可。
import { defineConfig } from '@playwright/test'
import base from './playwright.config'
import type { WorkspaceOptions } from './tests/browser/workspace-fixture'

export default defineConfig<WorkspaceOptions>({
  ...base,
  testMatch: '**/workspace-performance.spec.ts',
  testIgnore: ['**/fixtures/**'],
  timeout: 180_000,
  outputDir: 'test-results/ui-performance',
})
