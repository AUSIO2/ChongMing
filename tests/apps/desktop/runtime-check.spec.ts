// 在本地服务启动及关闭双失败时，验证实际运行检查仍释放模型端点、环境变量和目录。
import { createServer } from 'node:http'
import { mkdtemp, stat } from 'node:fs/promises'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(), disconnect: vi.fn() }))
vi.mock('../../../apps/desktop/local-service-process', () => ({ clientCreateService: () => ({ start: state.start, close: state.close }) }))
vi.mock('../../../client/graph-client', () => ({ clientCreateGateway: () => ({ disconnect: state.disconnect }) }))
vi.mock('node:http', async importOriginal => {
  // 保留真实 HTTP 实现，仅记录本检查拥有的模型端点。
  const actual = await importOriginal<typeof import('node:http')>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})
vi.mock('node:fs/promises', async importOriginal => {
  // 保留真实临时目录与删除过程，记录路径以独立检查目录确已释放。
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) }
})

import { desktopCheckRuntime } from '../../../scripts/check-desktop-runtime'

beforeEach(() => {
  // 清除前一用例观测，原生端点与目录实现保持不变。
  state.start.mockReset()
  state.close.mockReset().mockResolvedValue(undefined)
  state.disconnect.mockReset().mockResolvedValue(undefined)
  vi.mocked(createServer).mockClear()
  vi.mocked(mkdtemp).mockClear()
})

describe('packaged runtime check cleanup', () => {
  // 启动在真实子进程 seam 拒绝；无需运行模型或打包 Node 才能验证本层资源所有权。
  it.each([false, true])('preserves startup failure and drains all resources when close also fails: %s', async secondaryFails => {
    // 正常清理保留原始错误，双失败同时保留有序主错和次错。
    const primary = new Error('service startup failed'), secondary = new Error('service close failed')
    state.start.mockRejectedValue(primary)
    if (secondaryFails) state.close.mockRejectedValue(secondary)
    const priorUrl = process.env.DEEPSEEK_BASE_URL, priorKey = process.env.DEEPSEEK_API_KEY
    if (secondaryFails) await expect(desktopCheckRuntime()).rejects.toMatchObject({ errors: [primary, secondary] })
    else await expect(desktopCheckRuntime()).rejects.toBe(primary)
    expect(state.disconnect).toHaveBeenCalledOnce()
    expect(state.close).toHaveBeenCalledOnce()
    expect(process.env.DEEPSEEK_BASE_URL).toBe(priorUrl)
    expect(process.env.DEEPSEEK_API_KEY).toBe(priorKey)
    const server = vi.mocked(createServer).mock.results[0].value
    expect(server.listening).toBe(false)
    const directory = await vi.mocked(mkdtemp).mock.results[0].value
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
