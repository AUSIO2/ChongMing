// 105入口先行：真实本机资源与Host已有runner seam，模型和配置读取均在测试边界替换。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { hostCreateWorker, HostExecutionEvent, HostInput } from '../../../backend/execution/host-worker'
import type { DshWorkInput } from '../../../backend/execution/dsh/work-executor'
import type { WorkRunResult } from '../../../backend/execution/work-api'
import { localCreateRuntime } from '../../../apps/local-server/runtime'
import * as storage from '../../../backend/adapters/storage/sqlite/persistence'

type EntryStart = () => Promise<() => Promise<void>>
const state = vi.hoisted(() => {
  // 保存入口交接与Host装配调用；不启动消费者、模型或读取真实本机配置。
  const value: {
    host: ReturnType<typeof vi.fn<typeof hostCreateWorker>>
    codex: ReturnType<typeof vi.fn<(/* Host交付的当前Work和部署二进制。 */ input: unknown) => Promise<WorkRunResult>>>
    start: ReturnType<typeof vi.fn<() => Promise<void>>>
    close: ReturnType<typeof vi.fn<() => Promise<void>>>
    config: ReturnType<typeof vi.fn<() => Promise<{ settings: Record<string, never>; secrets: Record<string, never> }>>>
    queue: ReturnType<typeof vi.fn>
    entry: EntryStart | null
  } = { host: vi.fn(), codex: vi.fn(), start: vi.fn(), close: vi.fn(), config: vi.fn(), queue: vi.fn(), entry: null }
  return value
})
vi.mock('../../../backend/execution/host-worker', () => /* 只替换Host创建，runtime仍真实初始化API和SQLite。 */ ({ hostCreateWorker: state.host }))
vi.mock('../../../backend/execution/codex/work-executor', () => /* runner选择后只观测冻结入参，不运行Codex。 */ ({ codexRunWork: state.codex }))
vi.mock('../../../backend/adapters/messaging/rabbitmq', () => /* 独立Host入口只观测队列构造，不连接消息代理。 */ ({ queueCreateTransport: state.queue }))
vi.mock('../../../apps/config/local-settings', () => /* 入口不接触用户配置或密钥。 */ ({ localReadConfiguration: state.config }))
vi.mock('../../../platform/node/process-boundary', () => ({ processRunEntry: (
  /* 生产入口交给进程边界的实际启动动作。 */ input: { start: EntryStart },
) => { /* 不注册进程级监听，由用例按原入口启动。 */ state.entry = input.start } }))

const directories: string[] = [], closing: Array<() => Promise<void>> = []
const originalArgv = [...process.argv]
beforeEach(() => {
  // 每例恢复独立装配观测，部署环境只使用明确的测试值。
  vi.resetModules()
  state.entry = null
  state.start.mockReset().mockResolvedValue(undefined)
  state.close.mockReset().mockResolvedValue(undefined)
  state.host.mockReset().mockImplementation(() => {
    // 消费者生命周期保持Host原接口，默认runner是否传入由用例直接核对。
    return { hostId: 'fixture-host', concurrency: 1, start: state.start, close: state.close,
      finished: async () => { /* 测试Host没有消费循环异常。 */ return undefined } }
  })
  state.codex.mockReset().mockResolvedValue({ workId: 'fixture-work', mapId: 'fixture-map', runId: 'fixture-run',
    operationId: 'fixture-operation', sessionId: null, status: 'accepted', finalResponse: '' })
  state.config.mockReset().mockResolvedValue({ settings: {}, secrets: {} })
  state.queue.mockReset().mockReturnValue({ namespace: 'fixture', open: async () => { /* Host已替换，不应连接外部队列。 */ throw new Error('Unexpected queue connection') } })
  vi.stubEnv('CHONGMING_AMQP_URL', 'amqp://127.0.0.1/unused-executor-test')
  vi.stubEnv('CHONGMING_DATA_TOKEN', 'fixture-only-data-token')
  vi.stubEnv('CHONGMING_EXECUTOR', undefined)
  vi.stubEnv('CHONGMING_CODEX_BIN', undefined)
  vi.spyOn(console, 'log').mockImplementation(() => { /* 不将合成入口日志混入测试报告。 */ })
})
afterEach(async () => {
  // 先关闭所有本例真实API/SQLite，再恢复argv、环境和spy，不留下全局监听或目录锁。
  for (const close of closing.splice(0).reverse()) await close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  process.argv = [...originalArgv]
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function ownDirectory(): Promise<string> {
  // 真实runtime只访问当前测试创建的私有临时目录。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-executor-entry-'))
  directories.push(directory)
  return directory
}

function workInput(
  /* 本例独占的进程目录，不含用户文件。 */ directory: string,
): DshWorkInput {
  // 只构造runner交接所需的可信Work，不在本层伪造API接纳或真实模型结果。
  return { dataApiUrl: 'http://127.0.0.1:49100', token: 'fixture-only-data-token', dshHome: path.join(directory, 'dsh'),
    processCwd: directory, signal: new AbortController().signal, env: { FIXTURE_ONLY: 'yes' },
    onEvent: () => { /* 只核对同一事件接收者被透传。 */ },
    grant: { workId: 'fixture-work', mapId: 'fixture-map', runId: 'fixture-run', operationId: 'fixture-operation', stageId: 'fixture-stage',
      slotId: 'fixture-slot', specHash: 'fixture-spec', priority: 'medium', hostId: 'fixture-host', holderId: 'fixture-holder', fence: 1,
      expiresAt: '2999-01-01T00:00:00.000Z', leaseMs: 30000 } }
}

function selectedRunner(): Parameters<typeof hostCreateWorker>[1] {
  // Host工厂必须只建立一次，取得它真正收到的可选runner而非推断配置字符串。
  expect(state.host).toHaveBeenCalledOnce()
  const call = state.host.mock.calls[0]
  if (!call) throw new Error('Expected Host assembly')
  return call[1]
}

describe('105 owned runtime executor assembly', () => {
  // 默认DSH与显式Codex共享原Host授权生命周期，非法值在创建资源前拒绝。
  it.each([undefined, 'dsh'] as const)('keeps the original default DSH runner for executor=%s', async (
    /* 兼容旧调用省略或明确指定DSH的部署选择。 */ executor,
  ) => {
    const runtime = await localCreateRuntime({ directory: await ownDirectory(), port: 0, executor })
    closing.push(runtime.close)
    expect(selectedRunner()).toBeUndefined()
    expect(state.codex).not.toHaveBeenCalled()
  })

  it('selects Codex explicitly and forwards only the bound Work with the configured binary', async () => {
    // 真实runtime原实现忽略executor时，此处runner为空而不是有效Codex装配。
    const directory = await ownDirectory(), codexBin = '/fixture/bin/codex'
    const runtime = await localCreateRuntime({ directory, port: 0, executor: 'codex', codexBin })
    closing.push(runtime.close)
    const runner = selectedRunner()
    expect(runner).toBeTypeOf('function')
    if (!runner) throw new Error('Expected selected Codex runner')
    const work = workInput(directory)
    expect(await runner(work)).toMatchObject({ status: 'accepted', workId: work.grant.workId })
    expect(state.codex).toHaveBeenCalledWith({ grant: work.grant, dataApiUrl: work.dataApiUrl, token: work.token,
      signal: work.signal, processCwd: work.processCwd, env: work.env, onEvent: work.onEvent, codexBin })
  })

  it('passes the optional Host execution observer through without inventing another event protocol', async () => {
    // 实际Host包裹的Work/租约身份与原事件交给演示所有者，不把令牌或stdin放入事件。
    const onEvent = vi.fn<NonNullable<HostInput['onEvent']>>()
    const runtime = await localCreateRuntime({ directory: await ownDirectory(), port: 0, onEvent })
    closing.push(runtime.close)
    const call = state.host.mock.calls[0]
    expect(call?.[0].onEvent).toBe(onEvent)
    const event: HostExecutionEvent = { hostId: 'fixture-host', executionSlotId: 'fixture-execution-slot', workId: 'fixture-work',
      holderId: 'fixture-holder', fence: 1, event: { method: 'codex.exec.started', params: { workId: 'fixture-work', model: 'fixture-model' } } }
    call?.[0].onEvent?.(event)
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(event)
  })

  it.each(['unknown', '', null])('rejects an invalid runtime executor %s before constructing SQLite or a Host', async (
    /* 绕过TypeScript的真实JavaScript调用边界值。 */ executor,
  ) => {
    // 原输入签名不是运行时校验；非法值不得先建立服务或生成身份数据库。
    const create = vi.spyOn(storage, 'sqliteCreatePersistence')
    const input = { directory: await ownDirectory(), port: 0, executor }
    const attempt: ReturnType<typeof localCreateRuntime> = Reflect.apply(localCreateRuntime, undefined, [input])
    let problem: unknown
    try { const runtime = await attempt; closing.push(runtime.close) }
    catch (cause) { problem = cause }
    expect(problem).toBeInstanceOf(Error)
    expect(problem).toMatchObject({ message: 'Executor must be dsh or codex.' })
    expect(create).not.toHaveBeenCalled()
    expect(state.host).not.toHaveBeenCalled()
  })
})

describe('105 public service entry executor parameters', () => {
  // 两个入口都用真实parseArgs和原启动编排，只替换配置/队列/Host边界。
  it.each(['host', 'local'] as const)('keeps DSH as the default at the %s CLI entry', async (
    /* 未提供executor参数的原公开入口。 */ entry,
  ) => {
    // 原命令不指定新选项时仍把默认runner留给Host，不隐式迁移已有部署。
    const directory = await ownDirectory()
    process.argv = [process.execPath, 'fixture-entry', ...(entry === 'host' ? ['--dsh-home', directory] : ['--directory', directory, '--port', '0'])]
    if (entry === 'host') await import('../../../apps/execution-host/main')
    else await import('../../../apps/local-server/main')
    const start = state.entry
    if (!start) throw new Error('Expected process entry start')
    closing.push(await start())
    expect(selectedRunner()).toBeUndefined()
    expect(state.codex).not.toHaveBeenCalled()
  })

  it.each(['host', 'local'] as const)('assembles explicit Codex from %s CLI flags', async (
    /* 独立协作Host或SQLite本机入口。 */ entry,
  ) => {
    const directory = await ownDirectory(), codexBin = '/fixture/bin/custom-codex'
    process.argv = [process.execPath, 'fixture-entry', '--executor', 'codex', '--codex-bin', codexBin,
      ...(entry === 'host' ? ['--dsh-home', directory] : ['--directory', directory, '--port', '0'])]
    if (entry === 'host') await import('../../../apps/execution-host/main')
    else await import('../../../apps/local-server/main')
    const start = state.entry
    if (!start) throw new Error('Expected process entry start')
    closing.push(await start())
    const runner = selectedRunner()
    expect(runner).toBeTypeOf('function')
    if (!runner) throw new Error('Expected CLI selected Codex runner')
    await runner(workInput(directory))
    expect(state.codex).toHaveBeenCalledWith(expect.objectContaining({ codexBin }))
  })

  it.each(['host', 'local'] as const)('rejects an unsupported %s CLI executor before configuration or resources', async (
    /* 当前要验证公开参数边界的入口。 */ entry,
  ) => {
    const create = vi.spyOn(storage, 'sqliteCreatePersistence')
    process.argv = [process.execPath, 'fixture-entry', '--executor', 'unsupported']
    if (entry === 'host') await import('../../../apps/execution-host/main')
    else await import('../../../apps/local-server/main')
    const start = state.entry
    if (!start) throw new Error('Expected process entry start')
    await expect(start()).rejects.toThrow('Executor must be dsh or codex.')
    expect(state.config).not.toHaveBeenCalled()
    expect(state.queue).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(state.host).not.toHaveBeenCalled()
  })
})
