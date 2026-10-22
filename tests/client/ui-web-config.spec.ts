// 用真实 Vite 配置解析覆盖合并行为，替代为文件监听额外搭建完整重启/租约环境。
import path from 'node:path'
import { resolveConfig } from 'vite'
import { expect, it } from 'vitest'

import { workspaceCreateStaticDocumentPlugin } from '../browser/workspace-vite'

it('测试 Web 配置合并后实际关闭文件监听并保留 HMR 连接配置', async () => {
  // 使用现有项目配置，防止 inline null 被 Vite 合并忽略的回归。
  const previousWeb = process.env.CHONGMING_WEB, previousApi = process.env.CHONGMING_GRAPH_API
  process.env.CHONGMING_WEB = '1'
  process.env.CHONGMING_GRAPH_API = 'http://127.0.0.1:4320'
  try {
    const config = await resolveConfig({ configFile: path.resolve('vite.config.ts'),
      plugins: [workspaceCreateStaticDocumentPlugin()], logLevel: 'silent' }, 'serve')
    expect(config.server.watch).toBeNull()
    expect(config.server.hmr).not.toBe(false)
  } finally {
    // 环境归还当前进程，后续测试不能继承本例配置。
    if (previousWeb === undefined) delete process.env.CHONGMING_WEB
    else process.env.CHONGMING_WEB = previousWeb
    if (previousApi === undefined) delete process.env.CHONGMING_GRAPH_API
    else process.env.CHONGMING_GRAPH_API = previousApi
  }
})
