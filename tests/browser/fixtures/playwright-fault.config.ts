// 继承真实入口的产物策略，只为外层故障测试收窄发现范围与临时输出位置。
import path from 'node:path'
import { defineConfig } from '@playwright/test'
import base from '../../../playwright.config'

enum FaultConfigError { MISSING_OUTPUT_DIRECTORY = 'M00 故障夹具缺少绝对输出目录' }

const outputDir = process.env.CHONGMING_M00_FAULT_OUTPUT_DIR
if (!outputDir || !path.isAbsolute(outputDir)) throw new Error(FaultConfigError.MISSING_OUTPUT_DIRECTORY)

export default defineConfig({
  ...base,
  testDir: path.resolve(process.cwd(), 'tests/browser/fixtures'),
  testMatch: 'runner-fault.spec.ts',
  testIgnore: [],
  projects: [{ name: 'local' }],
  workers: 1,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 1_000 },
  reporter: [[path.resolve(process.cwd(), 'tests/browser/safe-reporter.ts')]],
  outputDir,
})
