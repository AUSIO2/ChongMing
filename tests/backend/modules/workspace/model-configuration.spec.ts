// 真实SQLite事务验证模型连接的权限、继承和执行快照，密钥算法使用显式端口夹具。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_SEED } from '../../../../apps/config/default-prompts'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { authCreateService } from '../../../../backend/modules/identity/identity-service'
import { controlCreateService } from '../../../../backend/modules/workspace/workspace-service'
import { controlReadCommand, controlReadQuery } from '../../../../backend/modules/workspace/workspace-input'
import type { ModelConnectionInput, ModelConnectionView, ModelScope } from '../../../../contracts/model-connection'
import type { ModelSecretCodec } from '../../../../backend/ports/model-secrets'
import type { WorkspaceView } from '../../../../contracts/control'

const closures: Array<() => Promise<unknown>> = []
const workspaceKey = 'workspace-fixture-api-key', agentKey = 'agent-fixture-api-key'
const workspaceConfiguration: ModelConnectionInput = { provider: 'deepseek-official', model: 'deepseek-flash', baseUrl: null, apiKey: workspaceKey }
afterEach(async () => {
  // 先关闭当前例的连接，再移除该例独占目录。
  for (const close of closures.splice(0).reverse()) await close()
})

async function fixture(withCodec = true) {
  // 不读取用户配置或真实Key；opaque字典只是加密端口seam，真正AES由适配器测试验证。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-model-'))
  closures.push(() => rm(directory, { recursive: true, force: true }))
  const database = sqliteCreatePersistence(directory)
  closures.push(() => database.close())
  const values = new Map<string, string>()
  const codec: ModelSecretCodec = {
    seal(value) { const opaque = randomUUID(); values.set(opaque, value); return opaque },
    open(value) { const original = values.get(value); if (!original) throw new Error('Unknown fixture cipher'); return original },
  }
  const auth = authCreateService(database)
  const control = Reflect.apply(controlCreateService, undefined, [database, DEFAULT_WORKSPACE_SEED, 'none', false,
    withCodec ? { modelSecrets: codec } : {}]) as ReturnType<typeof controlCreateService>
  await auth.initialize(); await control.initialize(); await control.seed()
  const tokens: Record<'owner' | 'editor' | 'viewer' | 'other', string> = {} as Record<'owner' | 'editor' | 'viewer' | 'other', string>
  const ids: Record<'owner' | 'editor' | 'viewer' | 'other', string> = {} as typeof tokens
  for (const role of ['owner', 'editor', 'viewer', 'other'] as const) {
    const user = await auth.createUser({ id: randomUUID(), displayName: role, hostAdmin: false })
    ids[role] = user.userId; tokens[role] = (await auth.createToken(user.userId)).token
  }
  async function command(role: keyof typeof tokens, method: string, params: unknown, requestId: string = randomUUID()) {
    return auth.transact(tokens[role], ctx => control.dispatch(ctx, controlReadCommand({ requestId, method, params })))
  }
  const workspace = (await command('owner', 'workspace.create', { id: randomUUID(), name: '模型配置', description: '', agentSource: 'library' })).data as WorkspaceView
  const scope: ModelScope = { kind: 'workspace', workspaceId: workspace.id }
  const agent = workspace.agents.find(item => item.kind === 'splitRoute')
  if (!agent) throw new Error('Missing default split route')
  const agentScope: ModelScope = { kind: 'agent', workspaceId: workspace.id, agentId: agent.id }
  async function read(target = scope, role: keyof typeof tokens = 'owner'): Promise<ModelConnectionView> {
    return await control.read(await auth.read(tokens[role]), controlReadQuery({ method: 'model.get', params: { scope: target } })) as ModelConnectionView
  }
  async function update(target: ModelScope, configuration: ModelConnectionInput, expectedRevision = 0, role: keyof typeof tokens = 'owner', requestId?: string) {
    return command(role, 'model.update', { scope: target, expectedRevision, configuration }, requestId)
  }
  return { auth, control, database, workspace, scope, agentScope, agent, command, read, update, tokens, ids, values }
}

describe('workspace-owned model connections', () => {
  it('stores only sealed keys and exposes configuration status without changing workspace or prompt revisions', async () => {
    const f = await fixture()
    expect(await f.read()).toMatchObject({ revision: 0, apiKeyConfigured: false, effective: { apiKeyConfigured: false } })
    const result = await f.update(f.scope, workspaceConfiguration)
    expect(result.data).toMatchObject({ revision: 1, provider: 'deepseek-official', model: 'deepseek-flash', apiKeyConfigured: true,
      effective: { baseUrl: 'https://api.deepseek.com', apiKeySource: 'workspace', apiKeyConfigured: true } })
    expect(JSON.stringify(result)).not.toContain(workspaceKey)
    expect(JSON.stringify(await f.database.records('model_connections').list())).not.toContain(workspaceKey)
    const workspace = await f.control.read(await f.auth.read(f.tokens.owner), { method: 'workspace.get', params: { workspaceId: f.workspace.id } }) as WorkspaceView
    expect(workspace.revision).toBe(f.workspace.revision)
    expect(workspace.agents).toEqual(f.workspace.agents)
  })

  it('inherits fields and keys independently, keeps omitted keys and explicitly clears agent overrides', async () => {
    const f = await fixture(); await f.update(f.scope, workspaceConfiguration)
    const inherited: ModelConnectionInput = { provider: null, model: 'agent-model', baseUrl: null }
    await f.update(f.agentScope, inherited)
    expect(await f.read(f.agentScope)).toMatchObject({ revision: 1, apiKeyConfigured: false,
      effective: { provider: 'deepseek-official', model: 'agent-model', apiKeySource: 'workspace' } })
    await f.update(f.agentScope, { ...inherited, apiKey: agentKey }, 1)
    await f.update(f.agentScope, { ...inherited, model: 'another-agent-model' }, 2)
    expect(await f.read(f.agentScope)).toMatchObject({ apiKeyConfigured: true, effective: { apiKeySource: 'agent' } })
    await f.update(f.agentScope, { provider: null, model: null, baseUrl: null, apiKey: null }, 3)
    expect(await f.read(f.agentScope)).toMatchObject({ revision: 4, apiKeyConfigured: false,
      effective: { model: 'deepseek-flash', apiKeySource: 'workspace' } })
  })

  it('does not reuse a workspace key for another provider, or keep a key after its target changes', async () => {
    const f = await fixture(); await f.update(f.scope, workspaceConfiguration)
    const other: ModelConnectionInput = { provider: 'openai', model: 'other-model', baseUrl: null }
    await f.update(f.agentScope, other)
    expect(await f.read(f.agentScope)).toMatchObject({ effective: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyConfigured: false, apiKeySource: null } })
    await f.update(f.agentScope, { ...other, apiKey: agentKey }, 1)
    await expect(f.update(f.agentScope, { provider: 'deepseek-official', model: 'another', baseUrl: null }, 2))
      .rejects.toMatchObject({ code: 'MODEL_KEY_TARGET_CHANGED' })
    expect((await f.read(f.agentScope)).revision).toBe(2)
  })

  it('enforces owner writes, member-only masked reads and actual agent membership', async () => {
    const f = await fixture()
    await f.command('owner', 'member.set', { workspaceId: f.workspace.id, expectedRevision: 0, userId: f.ids.editor, role: 'editor' })
    await f.command('owner', 'member.set', { workspaceId: f.workspace.id, expectedRevision: 1, userId: f.ids.viewer, role: 'viewer' })
    await f.update(f.scope, workspaceConfiguration)
    for (const role of ['editor', 'viewer'] as const) {
      expect(await f.read(f.scope, role)).toMatchObject({ apiKeyConfigured: true })
      await expect(f.update(f.scope, { ...workspaceConfiguration, apiKey: null }, 1, role)).rejects.toMatchObject({ status: 403 })
    }
    await expect(f.read(f.scope, 'other')).rejects.toMatchObject({ status: 404 })
    await expect(f.update(f.scope, workspaceConfiguration, 1, 'other')).rejects.toMatchObject({ status: 404 })
    await expect(f.read({ kind: 'agent', workspaceId: f.workspace.id, agentId: randomUUID() })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
  })

  it('uses its own revision and idempotent receipt without storing request plaintext', async () => {
    const f = await fixture(), requestId = randomUUID()
    await f.update(f.scope, workspaceConfiguration, 0, 'owner', requestId)
    expect((await f.update(f.scope, workspaceConfiguration, 0, 'owner', requestId)).replayed).toBe(true)
    await expect(f.update(f.scope, { ...workspaceConfiguration, apiKey: agentKey }, 0, 'owner', requestId)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    const results = await Promise.allSettled([
      f.update(f.scope, { ...workspaceConfiguration, model: 'candidate-a' }, 1),
      f.update(f.scope, { ...workspaceConfiguration, model: 'candidate-b' }, 1),
    ])
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect((await f.read()).revision).toBe(2)
    expect(JSON.stringify(await f.database.records('model_connections').list())).not.toContain(workspaceKey)
  })

  it('resolves a fresh model policy at execution freeze while leaving precise published profiles and prior snapshots unchanged', async () => {
    const f = await fixture(); await f.update(f.scope, workspaceConfiguration)
    const ctx = await f.auth.read(f.tokens.owner)
    const refs = [{ id: 'factcheck.split-news', version: 1 }]
    const first = await Reflect.apply(f.control.executionCatalog, f.control, [ctx, f.workspace.id, refs])
    const selected = first.agents.find((item: { ref: { id: string; version: number } }) => item.ref.id === f.agent.id && item.ref.version === 0)
    if (!selected) throw new Error('Missing frozen split route')
    expect(selected.profile).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' })
    await f.update(f.scope, { ...workspaceConfiguration, model: 'next-model', apiKey: undefined }, 1)
    const second = await Reflect.apply(f.control.executionCatalog, f.control, [ctx, f.workspace.id, refs])
    const next = second.agents.find((item: { ref: { id: string; version: number } }) => item.ref.id === f.agent.id && item.ref.version === 0)
    if (!next) throw new Error('Missing next split route')
    expect(next.profile.model).toBe('next-model')
    expect(selected.profile.model).toBe('deepseek-flash')
    const definitions = await f.control.definitions(ctx, f.workspace.id)
    expect(JSON.stringify(definitions)).not.toContain(workspaceKey)
    expect(JSON.stringify(definitions)).not.toContain('next-model')
    const result = await Reflect.apply(Reflect.get(f.control, 'readWorkModel'), f.control, [f.workspace.id, selected.profile])
    expect(result).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: workspaceKey })
  })

  it('rejects missing keys without a server fallback and does not write a key when no encryption codec is mounted', async () => {
    const f = await fixture(false)
    await expect(f.update(f.scope, workspaceConfiguration)).rejects.toMatchObject({ code: 'MODEL_SECRETS_UNAVAILABLE' })
    expect(await f.database.records('model_connections').count()).toBe(0)
    const ctx = await f.auth.read(f.tokens.owner)
    await expect(Reflect.apply(f.control.executionCatalog, f.control, [ctx, f.workspace.id, [{ id: 'factcheck.split-news', version: 1 }]]))
      .rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_MISSING' })
  })

  it('rejects unknown fields, embedded URL credentials, nonofficial endpoints and wrong scope shapes', async () => {
    const f = await fixture()
    for (const configuration of [
      { ...workspaceConfiguration, unknown: true },
      { ...workspaceConfiguration, apiKey: '' },
      { ...workspaceConfiguration, baseUrl: 'https://user:password@api.deepseek.com' },
      { ...workspaceConfiguration, baseUrl: 'https://example.test' },
      { ...workspaceConfiguration, provider: 'unknown-provider' },
    ]) await expect(f.update(f.scope, configuration)).rejects.toMatchObject({ status: 400 })
    expect(() => controlReadQuery({ method: 'model.get', params: { scope: { kind: 'library' } } })).toThrow()
    expect(await f.database.records('model_connections').count()).toBe(0)
  })

  it('accepts legitimate custom agent identifiers rather than requiring generated UUIDs', async () => {
    const f = await fixture()
    await f.command('owner', 'agent.create', { scope: f.scope, expectedRevision: 0, agent: {
      id: 'custom-model-agent', name: '自定义智能体', description: '合法非UUID身份', content: '按阶段要求输出事实。', tools: [],
      provider: null, model: null, promptPath: 'custom/model-agent', kind: 'splitSubAgent', promptVars: [],
      defaultPriority: 'medium', claimCategory: null,
    } })
    const scope: ModelScope = { kind: 'agent', workspaceId: f.workspace.id, agentId: 'custom-model-agent' }
    await f.update(scope, workspaceConfiguration)
    expect(await f.read(scope)).toMatchObject({ scope, apiKeyConfigured: true, effective: { apiKeySource: 'agent' } })
  })
})
