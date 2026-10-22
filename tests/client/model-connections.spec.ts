// 模型配置经过现有HTTP客户端：严格核对scope，任何Key或密文字段都不能进入Renderer。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_COMMAND_METHODS, CLIENT_QUERY_METHODS, clientCreateApi } from '../../client/graph-client'
import type { ModelConnectionView, ModelScope } from '../../contracts/model-connection'

const workspace: ModelScope = { kind: 'workspace', workspaceId: 'workspace-models' }
const agent: ModelScope = { kind: 'agent', workspaceId: 'workspace-models', agentId: 'custom-agent' }
const clients: Array<ReturnType<typeof clientCreateApi>> = []
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks() })

function view(scope: ModelScope = workspace): ModelConnectionView {
  // 同一scope明确区分自己的Key与继承后的可用Key，绝不提供伪脱敏字符串。
  return { scope, revision: 2, provider: scope.kind === 'workspace' ? 'deepseek-official' : null,
    model: scope.kind === 'workspace' ? 'deepseek-flash' : null, baseUrl: null, apiKeyConfigured: scope.kind === 'workspace',
    effective: { provider: 'deepseek-official', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKeyConfigured: true, apiKeySource: 'workspace' } }
}
function fixture(data: unknown, requestId = 'response') {
  // 只替换公网HTTP响应，不替换客户端验证器或网关方法。
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, requestId, replayed: false, data }))
  const client = clientCreateApi({ baseUrl: 'https://models.example.test', token: 'fixture-token', fetch: fetcher })
  clients.push(client)
  return { client, fetcher }
}

describe('model connection public client boundary', () => {
  it('registers the two fixed methods and accepts exact workspace and agent masked views', async () => {
    expect(CLIENT_QUERY_METHODS).toContain('model.get')
    expect(CLIENT_COMMAND_METHODS).toContain('model.update')
    for (const scope of [workspace, agent]) {
      const f = fixture(view(scope))
      expect(await f.client.read('model.get', { scope })).toEqual(view(scope))
      const init = f.fetcher.mock.calls[0]?.[1]
      expect(typeof init?.body === 'string' ? JSON.parse(init.body) : null).toEqual({ method: 'model.get', params: { scope } })
    }
  })

  it('sends a new key only to the fixed write endpoint and accepts a matching masked result', async () => {
    const f = fixture(view(), 'write-model')
    const result = await f.client.dispatch('write-model', 'model.update', { scope: workspace, expectedRevision: 1,
      configuration: { provider: 'deepseek-official', model: 'deepseek-flash', baseUrl: null, apiKey: 'fixture-write-only-key' } })
    expect(result.data).toEqual(view())
    expect(JSON.stringify(result.data)).not.toContain('fixture-write-only-key')
    expect(String(f.fetcher.mock.calls[0]?.[0])).toBe('https://models.example.test/api/v1/command')
  })

  it('rejects another scope, malformed configuration fields and inconsistent configured status', async () => {
    const invalid = [
      { ...view(), scope: { kind: 'workspace', workspaceId: 'another-workspace' } },
      { ...view(agent), scope: { ...agent, agentId: 'another-agent' } },
      { ...view(), scope: { ...workspace, agentId: 'extra-agent' } },
      { ...view(), revision: -1 },
      { ...view(), provider: 42 },
      { ...view(), apiKeyConfigured: 'yes' },
      { ...view(), effective: { ...view().effective, apiKeyConfigured: false } },
      { ...view(), effective: { ...view().effective, baseUrl: 'https://secret@api.deepseek.com' } },
    ]
    for (const data of invalid) {
      const f = fixture(data)
      await expect(f.client.read('model.get', { scope: workspace })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  })

  it('rejects plaintext or ciphertext anywhere in both read and write responses', async () => {
    const invalid = [
      { ...view(), apiKey: 'must-not-enter-renderer' },
      { ...view(), ciphertext: 'sealed-private-value' },
      { ...view(), secret: { ciphertext: 'sealed-private-value' } },
      { ...view(), effective: { ...view().effective, apiKey: 'must-not-enter-renderer' } },
      { ...view(), scope: { ...workspace, ciphertext: 'sealed-private-value' } },
    ]
    for (const data of invalid) {
      const f = fixture(data)
      await expect(f.client.read('model.get', { scope: workspace })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      const write = fixture(data, 'write-model')
      await expect(write.client.dispatch('write-model', 'model.update', { scope: workspace, expectedRevision: 1,
        configuration: { provider: null, model: null, baseUrl: null } })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  })

  it('requires the new bootstrap capability to be boolean when present', async () => {
    const f = fixture({ identity: { userId: 'owner', displayName: 'Owner', hostAdmin: false },
      settings: { revision: 0, llm: { provider: 'legacy', model: 'legacy' }, tools: [], limits: { maxAgentSlots: 1 } },
      metadata: { variables: {}, capabilities: { modelConnections: 'yes' } } })
    await expect(f.client.read('app.bootstrap', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
