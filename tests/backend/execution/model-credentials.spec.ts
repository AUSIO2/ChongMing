// 110先行：工作凭据只由受权接口交付，环境污染不能成为模型Key兜底。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sdk from '@deepseek-ai/dsh-sdk-client'
import type { GraphDataRead, GraphWorkGrant } from '../../../contracts/graph-work'
import * as workApi from '../../../backend/execution/work-api'
import * as runtimeApi from '../../../backend/execution/dsh/runtime'
import { dshRunWork } from '../../../backend/execution/dsh/work-executor'

vi.mock('@deepseek-ai/dsh-sdk-client', { spy: true })
const directories: string[] = []
afterEach(async () => {
  // 只收回本例替身、环境及临时工作目录。
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
function grant(): GraphWorkGrant {
  // 固定本次租约身份，使模型接口请求必须与数据读取使用同一证明。
  return { workId: 'work', mapId: 'map', runId: 'run', operationId: 'operation', stageId: 'route', slotId: 'route',
    specHash: 'spec', hostId: 'host', holderId: 'holder', fence: 8, leaseMs: 30_000,
    priority: 'medium', expiresAt: '2099-01-01T00:00:00Z' }
}
function data(work = grant()): GraphDataRead {
  // 数据投影只含已冻结的非秘密连接字段，不容纳API Key。
  return { mapId: work.mapId, runId: work.runId, operationId: work.operationId, specHash: work.specHash,
    transitionRef: { id: 'demo.split', version: 1 }, inputs: {}, context: {}, priorStageResults: [], promptVariables: {},
    stage: { id: work.stageId, slotId: work.slotId, tools: [], agent: { ref: { id: 'agent', version: 1 }, profile: {
      id: 'agent', name: '拆分', description: 'test', content: '提取事实', tools: [], provider: 'deepseek-official',
      model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com',
    } } }, outputContract: { mode: 'outputs', ports: [] }, proposalId: 'proposal',
    work: { id: work.workId, stageId: work.stageId, slotId: work.slotId, specHash: work.specHash, status: 'ready' } }
}
const model = { provider: 'deepseek-official', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'fake-workspace-key-110' }

describe('110受权工作模型连接', () => {
  it('uses the private model endpoint with exact work proof while data contains no secret', async () => {
    const work = grant(), view = data(work)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, data: model }))
    const result = await workApi.workReadModel({ grant: work, token: 'internal-only', dataApiUrl: 'https://data.example' }, view)
    expect(result).toEqual(model)
    const request = fetcher.mock.calls[0][0] as Request
    expect(request.url).toBe('https://data.example/internal/v1/model/read')
    expect(await request.json()).toEqual({ mapId: work.mapId, operationId: work.operationId })
    expect(request.headers.get('x-work-id')).toBe(work.workId)
    expect(request.headers.get('x-work-holder')).toBe(work.holderId)
    expect(request.headers.get('x-work-fence')).toBe(String(work.fence))
    expect(JSON.stringify(view)).not.toContain(model.apiKey)
  })

  it.each(['key', 'provider', 'model', 'baseUrl'] as const)('rejects missing or mismatched %s without falling back to ambient credentials', async field => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'fake-server-key-must-not-work')
    const invalid = { ...model, ...(field === 'key' ? { apiKey: '' } : { [field]: 'different' }) }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, data: invalid }))
    await expect(workApi.workReadModel({ grant: grant(), token: 'internal', dataApiUrl: 'https://data.example' }, data()))
      .rejects.toBeInstanceOf(Error)
  })

  it('does not launch DSH when its scoped key is missing', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-model-missing-')); directories.push(directory)
    const work = grant()
    const create = vi.spyOn(runtimeApi, 'dshCreateRuntime')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const request = input as Request
      if (request.url.endsWith('/work')) return Response.json({ ok: true, data: { workId: work.workId, status: 'ready' } })
      if (request.url.endsWith('/data/read')) return Response.json({ ok: true, data: data(work) })
      return Response.json({ ok: true, data: { ...model, apiKey: '' } })
    })
    await expect(dshRunWork({ grant: work, token: 'internal', dataApiUrl: 'https://data.example', dshHome: directory,
      env: { DEEPSEEK_API_KEY: 'fake-server-key-must-not-work' } })).rejects.toBeInstanceOf(Error)
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['deepseek-official', 'openai'])('keeps %s keys out of business prompts and patches and gives them only to the runtime boundary', async provider => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-model-work-')); directories.push(directory)
    const work = grant(), view = data(work), selected = { ...model, provider,
      baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : model.baseUrl }
    Object.assign(view.stage.agent.profile, { provider: selected.provider, baseUrl: selected.baseUrl })
    let accepted = false, patch = '', prompt = ''
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const request = input as Request
      if (request.url.endsWith('/work')) return Response.json({ ok: true, data: { workId: work.workId, status: accepted ? 'accepted' : 'ready' } })
      if (request.url.endsWith('/data/read')) return Response.json({ ok: true, data: view })
      return Response.json({ ok: true, data: selected })
    })
    const create = vi.spyOn(runtimeApi, 'dshCreateRuntime').mockImplementation(config => ({
      start: async () => { patch = await readFile(config.patches!.at(-1)!, 'utf8') },
      run: async input => { prompt = input.prompt; accepted = true; return { sessionId: 'session', finalResponse: 'accepted', events: [] } },
      close: async () => { /* 不创建外部进程，仅观察业务与凭据两个边界。 */ },
    }))
    const deploymentPatch = path.join(directory, 'deployment.patch.json')
    await writeFile(deploymentPatch, JSON.stringify([{ id: 'llm-deepseek', config: {
      apiKeyEnv: 'TAVILY_API_KEY', baseURL: 'https://wrong-deployment-endpoint.example',
    } }]))
    const result = await dshRunWork({ grant: work, token: 'internal', dataApiUrl: 'https://data.example', dshHome: directory,
      patches: [deploymentPatch], env: { TAVILY_API_KEY: 'fake-host-tool-key' } })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ modelConnection: selected }))
    const patchedPaths = create.mock.calls[0][0].patches!
    expect(patchedPaths.indexOf(deploymentPatch)).toBeLessThan(patchedPaths.length - 1)
    if (provider === 'deepseek-official') expect(JSON.parse(patch)).toEqual(expect.arrayContaining([{ id: 'llm-deepseek', config: {
      apiKeyEnv: 'CHONGMING_MODEL_API_KEY', baseURL: selected.baseUrl,
    } }]))
    if (provider === 'openai') expect(JSON.parse(patch)).toEqual(expect.arrayContaining([{ id: 'llm-pi-ai', config: { providers: { openai: {
      apiKeyEnv: 'CHONGMING_MODEL_API_KEY', baseURL: selected.baseUrl, api: 'openai-completions', models: [{ id: selected.model }],
    } } } }]))
    for (const value of [patch, prompt, JSON.stringify(result)]) expect(value).not.toContain(selected.apiKey)
  })

  it('clears ambient model keys and endpoints before injecting one selected connection', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'fake-server-secret'); vi.stubEnv('OPENAI_API_KEY', 'fake-other-secret')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://server.example'); vi.stubEnv('ANTHROPIC_API_KEY', 'fake-third-secret')
    const create = vi.mocked(sdk.DeepSeekHarness); create.mockClear()
    const runtime = runtimeApi.dshCreateRuntime({ dshHome: '/unused', cwd: '/tmp', processCwd: '/tmp',
      provider: model.provider, model: model.model, modelConnection: model,
      env: { OPENAI_BASE_URL: 'https://other.example', TAVILY_API_KEY: 'fake-tool-key', CHONGMING_DATA_TOKEN: 'fake-work-token' } })
    const env = create.mock.calls[0][0]!.env!
    expect(env.DEEPSEEK_API_KEY).toBe(model.apiKey)
    expect(env.DEEPSEEK_BASE_URL).toBe(model.baseUrl)
    for (const field of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL']) expect(env).not.toHaveProperty(field)
    expect(env.TAVILY_API_KEY).toBe('fake-tool-key')
    expect(env.CHONGMING_DATA_TOKEN).toBe('fake-work-token')
    expect(JSON.stringify(env)).not.toMatch(/fake-server-secret|fake-other-secret|fake-third-secret|server\.example/)
    await runtime.close()
  })

  it('does not forward a scoped Key even when an SDK event or final response echoes it', async () => {
    vi.spyOn(sdk.DeepSeekHarness.prototype, 'run').mockImplementation(async (_prompt, options) => {
      options?.onNotification?.({ method: 'session.event', params: { message: 'provider error ' + model.apiKey,
        nested: { authorization: 'Bearer ' + model.apiKey } } })
      return { sessionId: 'private-session', finalResponse: 'provider error ' + model.apiKey, events: [], notifications: [] }
    })
    const runtime = runtimeApi.dshCreateRuntime({ dshHome: '/unused', cwd: '/tmp', processCwd: '/tmp',
      provider: model.provider, model: model.model, modelConnection: model })
    const forwarded: unknown[] = []
    const result = await runtime.run({ prompt: 'non-sensitive test prompt' }, event => { forwarded.push(event) })
    expect(JSON.stringify({ result, forwarded })).not.toContain(model.apiKey)
    expect(result.finalResponse).toContain('[redacted]')
    await runtime.close()
  })
})
