// 112先行：独立搜索只访问本机HTTP夹具，真实DSH验证原有web_search工具接到新适配器。
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataRead, GraphWorkGrant } from '../../../contracts/graph-work'
import { workCreateModelEnvironment } from '../../../backend/execution/work-api'
import { dshRunWork } from '../../../backend/execution/dsh/work-executor'

interface SearchProvider {
  available(): boolean
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<unknown>
}
const servers: Server[] = [], directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => {
    server.closeAllConnections()
    return new Promise<void>(resolve => server.close(() => resolve()))
  }))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Search fixture did not bind')
  return `http://127.0.0.1:${address.port}`
}
async function fixture(body: unknown = { results: [] }, status = 200) {
  const calls: Array<{ path: string | undefined; method: string | undefined; keyMatches: boolean; body: unknown }> = []
  const baseUrl = await listen(createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    calls.push({ path: request.url, method: request.method,
      keyMatches: request.headers.authorization === 'Bearer fake-scoped-search-key',
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(typeof body === 'string' ? body : JSON.stringify(body))
  }))
  vi.stubEnv('DEEPSEEK_API_KEY', 'fake-scoped-search-key')
  vi.stubEnv('DEEPSEEK_BASE_URL', baseUrl)
  const plugin = await import('../../../backend/execution/dsh/dsh-deepseek-search-plugin.mjs')
  let provider!: SearchProvider
  plugin.apply({ web: { registerSearchProvider: (value: SearchProvider) => { provider = value } } })
  return { provider, calls, baseUrl }
}

describe('DeepSeek独立Search适配器', () => {
  it.each(['', '/v1'])('uses one standalone POST with scoped credentials and normalizes sources (base suffix %s)', async suffix => {
    const f = await fixture({ results: [
      { url: 'https://example.org/report', title: '原始报道', snippet: '关键词片段', summary: '来源摘要', date: '2024-06-25' },
      { url: 'https://example.org/second', title: '补充来源', snippet: '备用片段', date: null },
    ] })
    vi.stubEnv('DEEPSEEK_BASE_URL', f.baseUrl + suffix)
    expect(f.provider.available()).toBe(true)
    await expect(f.provider.search({ query: '嫦娥六号着陆', maxResults: 2 })).resolves.toEqual({ sources: [
      { url: 'https://example.org/report', title: '原始报道', snippet: '来源摘要', publishedAt: '2024-06-25' },
      { url: 'https://example.org/second', title: '补充来源', snippet: '备用片段' },
    ], truncated: false })
    expect(f.calls).toEqual([{ path: '/v1/tools/search', method: 'POST', keyMatches: true,
      body: { query: '嫦娥六号着陆', count: 2, need_content: false } }])
  })

  it('accepts an empty result list without inventing an answer', async () => {
    const f = await fixture()
    await expect(f.provider.search({ query: '没有命中的查询' })).resolves.toEqual({ sources: [], truncated: false })
    expect(f.calls[0].body).toMatchObject({ count: 10, need_content: false })
  })

  it('cannot use an OpenAI work key or a server DeepSeek key', async () => {
    const f = await fixture()
    const env = workCreateModelEnvironment({ DEEPSEEK_API_KEY: 'fake-ambient-key' }, {
      provider: 'openai', model: 'fixture', baseUrl: 'https://api.openai.com/v1', apiKey: 'fake-openai-key',
    })
    vi.stubEnv('DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY)
    vi.stubEnv('CHONGMING_MODEL_API_KEY', env.CHONGMING_MODEL_API_KEY)
    expect(f.provider.available()).toBe(false)
    await expect(f.provider.search({ query: '不可借用凭据' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    expect(f.calls).toHaveLength(0)
  })

  it.each([401, 402, 429])('reports HTTP %s without echoing provider error bodies or keys', async status => {
    const f = await fixture({ error: { message: 'echo fake-scoped-search-key' } }, status)
    const error = await f.provider.search({ query: '失败查询' }).catch(value => value)
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(String(error)).toContain(String(status))
    expect(String(error)).not.toContain('fake-scoped-search-key')
    expect(f.calls).toHaveLength(1)
  })

  it.each(['{invalid-json', {}, { results: [{}] }])('rejects malformed success responses instead of claiming no matches: %j', async body => {
    const f = await fixture(body)
    await expect(f.provider.search({ query: '坏响应' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('rejects invalid query/count before HTTP and counts Unicode characters correctly', async () => {
    const f = await fixture()
    for (const query of [' ', '字'.repeat(129)]) await expect(f.provider.search({ query })).rejects.toMatchObject({ code: 'WEB_INVALID_QUERY' })
    for (const maxResults of [0, 51, 1.5]) await expect(f.provider.search({ query: '查询', maxResults })).rejects.toMatchObject({ code: 'WEB_INVALID_QUERY' })
    expect(f.calls).toHaveLength(0)
    await f.provider.search({ query: '🌕'.repeat(128), maxResults: 50 })
    expect(f.calls).toHaveLength(1)
  })

  it('passes cancellation to an in-flight HTTP request', async () => {
    let received!: () => void
    const started = new Promise<void>(resolve => { received = resolve })
    const baseUrl = await listen(createServer((_request, _response) => { received() }))
    vi.stubEnv('DEEPSEEK_API_KEY', 'fake-scoped-search-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', baseUrl)
    const plugin = await import('../../../backend/execution/dsh/dsh-deepseek-search-plugin.mjs')
    let provider!: SearchProvider
    plugin.apply({ web: { registerSearchProvider: (value: SearchProvider) => { provider = value } } })
    const stop = new AbortController()
    const result = provider.search({ query: '取消查询' }, stop.signal).catch(error => error)
    await started
    stop.abort()
    expect(await result).toMatchObject({ code: 'WEB_ABORTED' })
  })
})

it('loads the new provider through the normal work patch and returns structured sources to a real DSH Agent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-deepseek-search-'))
  directories.push(directory)
  const work: GraphWorkGrant = { workId: 'work-search', mapId: 'map', runId: 'run', operationId: 'operation',
    stageId: 'assess', slotId: 'source', specHash: 'spec', priority: 'medium', hostId: 'host', holderId: 'holder',
    fence: 1, leaseMs: 30_000, expiresAt: '2099-01-01T00:00:00Z' }
  let accepted = false, sawSearchResult = false, modelCalls = 0
  const paths: string[] = [], errors: string[] = []
  let view: GraphDataRead
  const baseUrl = await listen(createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      paths.push(request.url!)
      if (request.url === '/v1/tools/search') {
        expect(request.headers.authorization).toBe('Bearer fake-work-search-key')
        expect(body).toEqual({ query: '嫦娥六号', count: 8, need_content: false })
        return response.end(JSON.stringify({ results: [{ url: 'https://example.org/mission', title: '任务报道', summary: 'SEARCH_SOURCE_MARKER' }] }))
      }
      if (request.url === '/chat/completions') {
        expect(request.headers.authorization).toBe('Bearer fake-work-search-key')
        expect(body.tools.map((tool: any) => tool.function.name).sort()).toEqual(['data_propose', 'data_read', 'web_search'])
        modelCalls++
        const result = body.messages.find((message: any) => message.role === 'tool')
        if (result) {
          expect(result.content).toContain('SEARCH_SOURCE_MARKER')
          expect(result.content).toContain('https://example.org/mission')
          expect(result.content).not.toContain('fake-work-search-key')
          sawSearchResult = true
        }
        const name = result ? 'data_propose' : 'web_search'
        const args = result ? { proposal: { kind: 'outputs', reason: '来源已获取', outputs: [{ key: 'opinion', port: 'opinion',
          typeRef: { id: 'test.opinion', version: 1 }, payload: { text: 'SEARCH_SOURCE_MARKER' } }] } }
          : { queries: ['嫦娥六号'] }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
          id: 'call-' + modelCalls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
        return response.end('data: [DONE]\n\n')
      }
      let data: unknown
      if (request.url === '/internal/v1/work') data = { workId: work.workId, status: accepted ? 'accepted' : 'ready' }
      else if (request.url === '/internal/v1/data/read') data = view
      else if (request.url === '/internal/v1/model/read') data = { provider: 'deepseek-official', model: 'fixture', baseUrl, apiKey: 'fake-work-search-key' }
      else if (request.url === '/internal/v1/data/propose') { accepted = true; data = { accepted: true } }
      else throw new Error('Unexpected fixture path ' + request.url)
      response.end(JSON.stringify({ ok: true, data }))
    } catch (error) { errors.push(String(error)); response.writeHead(500); response.end('{}') }
  }))
  view = { mapId: work.mapId, runId: work.runId, operationId: work.operationId, specHash: work.specHash,
    transitionRef: { id: 'test.verify', version: 1 }, proposalId: 'proposal', inputs: {}, context: {}, priorStageResults: [], promptVariables: {},
    stage: { id: work.stageId, slotId: work.slotId, tools: [{ name: 'web_search', description: '搜索来源' }], agent: {
      ref: { id: 'test.agent', version: 1 }, profile: { id: 'test.agent', name: '核查', description: '查来源', content: '搜索后提交意见',
        tools: ['web_search'], provider: 'deepseek-official', model: 'fixture', baseUrl } } },
    outputContract: { mode: 'outputs', ports: [{ port: 'opinion', type: { id: 'test.opinion', version: 1 }, count: { min: 1, max: 1 },
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, references: [], successorOf: [] }] },
    work: { id: work.workId, stageId: work.stageId, slotId: work.slotId, specHash: work.specHash, status: 'ready' } }
  const patch = path.join(directory, 'fixture.patch.json')
  await writeFile(patch, JSON.stringify([
    { id: 'llm-deepseek', config: { thinking: 'disabled', streamIdleTimeoutMs: 3000 } },
    // 红灯阶段也把旧辅助搜索锁到本机，绝不让测试访问真实供应商。
    { id: 'web-search-deepseek', config: { baseURL: baseUrl + '/anthropic/v1' } },
  ]))
  const result = await dshRunWork({ grant: work, token: 'fake-internal-token', dataApiUrl: baseUrl, dshHome: directory,
    patches: [patch], maxTokens: 512, maxRounds: 1, env: { DSH_TELEMETRY_DISABLED: '1' } })
  expect(errors).toEqual([])
  expect(result.status).toBe('accepted')
  expect(sawSearchResult).toBe(true)
  expect(modelCalls).toBe(2)
  expect(paths.filter(value => value === '/v1/tools/search')).toHaveLength(1)
  expect(paths.some(value => value.includes('messages'))).toBe(false)
}, 30_000)
