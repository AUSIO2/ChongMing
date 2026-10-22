// M00 先行浏览器测试：真实页面/后端，固定项目且关闭含凭据的原始录制产物。
import { defineConfig } from '@playwright/test'
import type { WorkspaceOptions } from './tests/browser/workspace-fixture'

export default defineConfig<WorkspaceOptions>({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/fixtures/**', '**/workspace-performance.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results/ui',
  // 框架失败时仍会生成原始 error-context；先行阶段只留安全 JSON，不保留这些附件。
  preserveOutput: 'never',
  reporter: [['./tests/browser/safe-reporter.ts']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'local', use: { storage: 'sqlite' } },
    { name: 'collab', use: { storage: 'mongo' } },
  ],
})
