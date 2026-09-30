// 文件职责：验证 DSH 工作访问分类、冻结角色配置、SDK 生命周期和诊断事件流。
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sdk from '@deepseek-ai/dsh-sdk-client'
import type { DshRuntimeAPI } from '../../../contracts/dsh'
import type { GraphDataRead } from '../../../contracts/graph'
import * as dshRuntime from '../../../backend/execution/dsh/runtime'
import { dshCreateRuntime, dshReadEvent } from '../../../backend/execution/dsh/runtime'
import { dshHttpCreateServer } from '../../../backend/adapters/http/dsh-diagnostic-server'
import { dshRunWork, type DshWorkInput } from '../../../backend/execution/dsh/work-executor'

vi.mock('@deepseek-ai/dsh-sdk-client', { spy: true })

const temporaryDirectories: string[] = []

afterEach(async () => {
  // 恢复测试替身和环境变量，并删除各用例创建的临时运行目录。
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map(directory => /* 删除该次 DSH 测试的独立目录。 */
    rm(directory, { recursive: true, force: true }),
  ))
})

function workInput(): DshWorkInput {
  // 构造固定工作授权与本地 API 地址，供访问失败分类测试使用。
  return {
    grant: {
      workId: 'operation:route', mapId: 'map', runId: 'run', operationId: 'operation',
      stageId: 'route', slotId: 'route', specHash: 'spec-hash', priority: 'medium', hostId: 'host', holderId: 'holder',
      fence: 1, expiresAt: '2099-01-01T00:00:00.000Z', leaseMs: 30000,
    },
    dataApiUrl: 'http://127.0.0.1:12345', token: 'test-only-token',
    dshHome: path.join(tmpdir(), 'unused-work-access-test'),
  }
}

describe('DSH work access failures', () => {
  // 覆盖暂时访问失败、永久配置错误与显式取消的区别。
  it('marks network, 5xx, 429 and lost-lease responses as access errors without retrying', async () => {
    // 验证网络、限流、服务器和租约错误统一为暂时访问失败，执行器自身不重试。
    const request = vi.spyOn(globalThis, 'fetch')
    request.mockRejectedValueOnce(new TypeError('connection reset'))
    await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'WorkAccessError' })
    for (const [status, code] of [[503, 'DATABASE_UNAVAILABLE'], [429, 'RATE_LIMITED'], [409, 'LEASE_LOST']] as const) {
      request.mockResolvedValueOnce(Response.json({ ok: false, error: { code, message: 'temporarily unavailable' } }, { status }))
      await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'WorkAccessError' })
    }
    request.mockResolvedValueOnce(new Response('proxy unavailable', { status: 502 }))
    await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'WorkAccessError' })
    expect(request).toHaveBeenCalledTimes(5)
  })

  it('also classifies input-read failures after a valid ready-work confirmation', async () => {
    // 验证状态确认成功后读取输入失败仍归类为暂时访问失败。
    const request = vi.spyOn(globalThis, 'fetch')
    request.mockResolvedValueOnce(Response.json({ ok: true, data: { workId: 'operation:route', status: 'ready' } }))
    request.mockResolvedValueOnce(Response.json({ ok: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'retry later' } }, { status: 503 }))
    await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'WorkAccessError' })
    expect(request).toHaveBeenCalledTimes(2)
    expect((request.mock.calls[1][0] as Request).url).toContain('/internal/v1/data/read')
  })

  it('preserves explicit cancellation and does not classify permanent configuration errors as retryable access', async () => {
    // 验证无效凭据不是可重试访问故障，显式取消保留原始原因。
    const request = vi.spyOn(globalThis, 'fetch')
    request.mockResolvedValueOnce(Response.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'invalid credentials' } }, { status: 401 }))
    await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'Error', message: 'UNAUTHORIZED: invalid credentials' })
    const stop = new AbortController()
    const reason = new Error('Host is shutting down')
    request.mockImplementationOnce(async () => {
      // 在模拟请求期间取消工作并抛出相同原因。
       stop.abort(reason); throw reason })
    await expect(dshRunWork({ ...workInput(), signal: stop.signal })).rejects.toBe(reason)
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('DSH operation profiles', () => {
  // 覆盖任意通用阶段对冻结 Agent 配置的选择。
  it.each([
    { stageId: 'parse', slotId: 'parse', prompt: 'Shared source' },
    { stageId: 'route', slotId: 'route', prompt: 'Frozen content' },
    { stageId: 'assess', slotId: 'angle-1', prompt: 'Independent angle' },
  ] as const)('binds $stageId/$slotId to its frozen profile and exact proposal identity', async ({ stageId, slotId, prompt }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-dsh-profile-'))
    temporaryDirectories.push(directory)
    const input = workInput()
    input.dshHome = directory
    input.grant = { ...input.grant, stageId, slotId }
    const profile = { id: `agent-${stageId}`, name: `Agent ${stageId}`, description: stageId, content: 'Task={{task}}', tools: [],
      provider: `${stageId}-provider`, model: `${stageId}-model`, promptVars: ['task'] }
    const data: GraphDataRead = {
      mapId: input.grant.mapId, runId: input.grant.runId, operationId: input.grant.operationId,
      transitionRef: { id: 'demo.transition', version: 1 }, specHash: input.grant.specHash,
      inputs: {}, context: {}, priorStageResults: [], promptVariables: { task: prompt },
      stage: { id: stageId, slotId, agent: { ref: { id: profile.id, version: 1 }, profile }, tools: [] },
      outputContract: { mode: 'outputs', ports: [] }, proposalId: 'exact-proposal-from-api',
      work: { id: input.grant.workId, stageId, slotId, specHash: input.grant.specHash, status: 'ready' },
    }
    const request = vi.spyOn(globalThis, 'fetch')
    request.mockResolvedValueOnce(Response.json({ ok: true, data: { workId: input.grant.workId, status: 'ready' } }))
    request.mockResolvedValueOnce(Response.json({ ok: true, data }))
    request.mockResolvedValueOnce(Response.json({ ok: true, data: { workId: input.grant.workId, status: 'accepted' } }))
    let patch: Array<{ id: string; config: Record<string, any> }> = []
    const close = vi.fn(async () => {
      // 模拟无外部资源的运行时关闭，供检查关闭调用次数。
    })
    const run = vi.fn<DshRuntimeAPI['run']>(async ({ sessionId }) => /* 模拟同一根会话成功结束一轮执行。 */  ({ sessionId: sessionId!, finalResponse: 'accepted', events: [] }))
    const create = vi.spyOn(dshRuntime, 'dshCreateRuntime').mockImplementation(config => /* 提供可观察启动补丁的运行时替身。 */  ({
      start: async () => {
        // 读取执行器生成的最后一份补丁，供可信绑定断言。
         patch = JSON.parse(await readFile(config.patches!.at(-1)!, 'utf8')) }, run, close,
    }))
    const result = await dshRunWork(input)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ provider: profile.provider, model: profile.model }))
    expect(patch[0].config).toMatchObject({ proposalId: data.proposalId, specHash: data.specHash, grant: input.grant,
      rootSessionId: result.sessionId, stage: data.stage, outputContract: data.outputContract })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: result.sessionId, prompt: expect.stringContaining(prompt) }), undefined)
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('DSH runtime facade', () => {
  // 覆盖 SDK 运行时的环境隔离、启停、通知复制及 HTTP 输出。
  it('keeps broker credentials and test configuration paths out of the DSH subprocess environment', async () => {
    // 验证 broker 凭据及测试配置路径不进入 DSH 子进程环境，Host 身份仍保留。
    vi.stubEnv('CHONGMING_AMQP_URL', 'amqp://brokerSecret@localhost')
    vi.stubEnv('CHONGMING_TEST_BROKER_FILE', '/private/brokerSecret.json')
    const create = vi.mocked(sdk.DeepSeekHarness)
    create.mockClear()
    const runtime = dshCreateRuntime({
      dshBin: path.resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), dshHome: '/unused-dsh-env-test',
      cwd: '/tmp', processCwd: '/tmp', provider: 'deepseek-official', model: 'deepseek-v4-flash',
      env: { CHONGMING_AMQP_URL: 'amqp://overrideBrokerSecret@localhost',
      CHONGMING_TEST_BROKER_FILE: '/private/overrideBrokerSecret.json', CHONGMING_HOST_ID: 'test-host' } })
    const options = create.mock.calls[0][0]!
    expect(options.env).not.toHaveProperty('CHONGMING_AMQP_URL')
    expect(options.env).not.toHaveProperty('CHONGMING_TEST_BROKER_FILE')
    expect(JSON.stringify(options)).not.toMatch(/brokerSecret/i)
    expect(options.env).toHaveProperty('CHONGMING_HOST_ID', 'test-host')
    expect(process.env.CHONGMING_AMQP_URL).toContain('brokerSecret')
    await runtime.close()
  })

  it('starts and closes the official SDK profile', async () => {
    // 启动官方 SDK 进程并验证重复关闭复用同一 Promise，关闭后禁止重启。
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-dsh-'))
    temporaryDirectories.push(directory)
    const runtime = dshCreateRuntime({
      dshBin: path.resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),
      dshHome: path.join(directory, 'home'),
      cwd: directory,
      processCwd: directory,
      profile: 'sdk',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    await expect(runtime.start()).resolves.toBeUndefined()
    const firstClose = runtime.close()
    const secondClose = runtime.close()
    expect(secondClose).toBe(firstClose)
    await expect(firstClose).resolves.toBeUndefined()
    await expect(secondClose).resolves.toBeUndefined()
    await expect(runtime.close()).resolves.toBeUndefined()
    await expect(runtime.start()).rejects.toThrow('closed')
  }, 20_000)

  it('copies SDK notifications into JSON-safe events', () => {
    // 验证 SDK 通知转为独立 JSON 数据，不保留 undefined 或共享嵌套引用。
    const params = { sessionId: 'session-1', status: 'idle', nested: { items: [1, true, null] }, ignored: undefined }
    const event = dshReadEvent({
      method: 'session.status',
      params,
    })
    expect(event).toEqual({
      method: 'session.status',
      params: { sessionId: 'session-1', status: 'idle', nested: { items: [1, true, null] } },
    })
    params.nested.items.push(2)
    expect(event.params.nested).toEqual({ items: [1, true, null] })
    expect(() => /* 传入不可 JSON 序列化的 BigInt，确认转换明确失败。 */  dshReadEvent({ method: 'invalid', params: { value: BigInt(1) } })).toThrow(TypeError)
  })

  it('streams events and a final result over NDJSON', async () => {
    // 验证诊断 HTTP 按顺序输出事件帧和最终结果帧。
    const runtime: DshRuntimeAPI = {
      start: async () => {
        // 诊断用运行时替身无需启动真实进程。
      },
      /**
       * 先发送运行事件，再返回指定会话的固定完成结果。
       *
       * @param input 诊断 HTTP 传入的提示词及可选会话身份，用于生成模拟完成结果。
       * @param onEvent 可选事件接收器，夹具向其推送一条运行中通知。
       */
      async run(input, onEvent) {
        onEvent?.({ method: 'session.status', params: { status: 'running' } })
        return { sessionId: input.sessionId ?? 'new-session', finalResponse: 'done', events: [] }
      },
      close: async () => {
        // 诊断用运行时替身没有需要关闭的资源。
      },
    }
    const server = dshHttpCreateServer(runtime)
    await new Promise<void>(resolve => /* 等待诊断 HTTP 服务监听本地临时端口。 */  server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/runtime/dsh/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', prompt: 'hello' }),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe([
        JSON.stringify({ type: 'event', event: { method: 'session.status', params: { status: 'running' } } }),
        JSON.stringify({ type: 'result', result: { sessionId: 'session-1', finalResponse: 'done', events: [] } }),
        '',
      ].join('\n'))
    } finally {
      await new Promise<void>((resolve, reject) => /* 将诊断服务器关闭转换为可等待清理。 */  server.close(error => /* 按服务器关闭结果结束或拒绝清理 Promise。 */  error ? reject(error) : resolve()))
    }
  })
})
