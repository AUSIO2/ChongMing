// 只由受控外层测试发现的真实浏览器故障，不连接任何业务后端。
import { expect, test } from '@playwright/test'

enum RunnerFaultError { MISSING_CANARY = 'M00 故障夹具缺少本轮秘密哨兵' }

const canary = process.env.CHONGMING_M00_REPORT_CANARY
if (!canary || !/^m00-canary-[a-f0-9]{32}$/.test(canary)) throw new Error(RunnerFaultError.MISSING_CANARY)

test(`M00-Q07 受控报告产物故障 ${canary}`, async (
  /* Playwright 管理的真实页面，只展示本轮测试生成的数据。 */ { page },
) => {
  // 填写密码后输出哨兵，再制造真正的断言失败；外层只检查安全结果及最终产物。
  await page.setContent('<main><label>测试令牌<input type="password" autocomplete="off"></label></main>')
  await page.getByLabel('测试令牌').fill(canary)
  console.log(canary)
  console.error(canary)
  await expect(page.getByLabel('测试令牌')).toHaveValue('m00-public-expected-value')
})
