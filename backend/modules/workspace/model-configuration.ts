// 模型连接独立于提示词定义保存；密钥只在可信Work读取时解密。
import type { GraphAgentProfile } from '../../../contracts/graph-agent'
import { ModelConnectionMessage, type ModelConnectionInput, type ModelConnectionView, type ModelScope, type ModelWorkConfiguration } from '../../../contracts/model-connection'
import type { ModelSecretCodec } from '../../ports/model-secrets'
import type { Persistence, StorageSession } from '../../ports/persistence'
import { storeCreateInputHash } from '../graph/graph-record'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadObject, inputReadString } from '../shared/input-validation'

interface StoredKey { ciphertext: string; provider: string; baseUrl: string }
interface ModelRecord {
  _id: string; scope: ModelScope; workspaceId: string; revision: number
  provider: string | null; model: string | null; baseUrl: string | null
  secret: StoredKey | null
  receipts: Array<{ userId: string; requestId: string; hash: string }>
}
interface ResolvedConnection {
  provider: string | null; model: string | null; baseUrl: string | null
  key: StoredKey | null; source: 'agent' | 'workspace' | null
}
const defaults: Record<string, string> = {
  'deepseek-official': 'https://api.deepseek.com', openai: 'https://api.openai.com/v1',
}

export function modelReadScope(/* 未经验证的工作区或Agent配置归属。 */ value: unknown): ModelScope {
  // 共享库不拥有Key；Agent身份必须在上层另行检查当前工作区归属。
  const item = inputReadObject(value, ['kind', 'workspaceId', 'agentId'], 'scope')
  const workspaceId = inputReadId(item.workspaceId, 'scope.workspaceId')
  if (item.kind === 'workspace') {
    inputReadObject(value, ['kind', 'workspaceId'], 'scope')
    return { kind: 'workspace', workspaceId }
  }
  if (item.kind === 'agent') {
    const agentId = inputReadString(item.agentId, 'scope.agentId')
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) throw new GraphError(400, 'MODEL_SCOPE_INVALID', ModelConnectionMessage.INVALID_SCOPE)
    return { kind: 'agent', workspaceId, agentId }
  }
  throw new GraphError(400, 'MODEL_SCOPE_INVALID', ModelConnectionMessage.INVALID_SCOPE)
}

function modelReadField(/* 可空的连接文本；null表示继承。 */ value: unknown): string | null {
  // 连接输入不沿用字符串强制转换，也不接受空白作为隐式删除。
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new GraphError(400, 'INVALID_ARGUMENT', ModelConnectionMessage.INVALID_FIELD)
  return value.trim()
}

export function modelReadConfiguration(/* 只接受明确字段和三态Key更新语义。 */ value: unknown): ModelConnectionInput {
  // 普通连接资料可公开，Key只从此写入口进入加密端口。
  const item = inputReadObject(value, ['provider', 'model', 'baseUrl', 'apiKey'], 'configuration')
  const provider = modelReadField(item.provider), model = modelReadField(item.model), rawBase = modelReadField(item.baseUrl)
  if (provider !== null && !Object.prototype.hasOwnProperty.call(defaults, provider)) throw new GraphError(400, 'INVALID_ARGUMENT', ModelConnectionMessage.INVALID_PROVIDER)
  let baseUrl: string | null = null
  if (rawBase !== null) {
    try {
      const parsed = new URL(rawBase)
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(ModelConnectionMessage.INVALID_BASE_URL)
      baseUrl = parsed.toString().replace(/\/$/, '')
    } catch { throw new GraphError(400, 'INVALID_ARGUMENT', ModelConnectionMessage.INVALID_BASE_URL) }
  }
  if (item.apiKey === undefined) return { provider, model, baseUrl }
  if (item.apiKey === null) return { provider, model, baseUrl, apiKey: null }
  if (typeof item.apiKey !== 'string' || !item.apiKey.trim() || item.apiKey.length > 8192 || /\s/.test(item.apiKey.trim())) {
    throw new GraphError(400, 'INVALID_ARGUMENT', ModelConnectionMessage.INVALID_KEY)
  }
  return { provider, model, baseUrl, apiKey: item.apiKey.trim() }
}

function recordId(/* 已验证的独立配置归属。 */ scope: ModelScope): string {
  // 主键同时包含工作区与Agent，不能跨工作区命中另一个Key。
  return scope.kind === 'workspace' ? `workspace:${scope.workspaceId}` : `agent:${scope.workspaceId}:${scope.agentId}`
}

function targetMatches(/* 一个已经绑定目标的密钥密文。 */ key: StoredKey, /* 当前实际调用目标。 */ target: Pick<ResolvedConnection, 'provider' | 'baseUrl'>): boolean {
  // 模型名称可变化；提供方和地址变化必须重新授权密钥。
  return key.provider === target.provider && key.baseUrl === target.baseUrl
}

export function modelCreateConfigurationService(
  /* 连接记录与调用方授权事务共用的持久化入口。 */ database: Persistence,
  /* 由部署装配的加密能力；本机测试可以显式允许回环模型端点。 */ options: { modelSecrets?: ModelSecretCodec; allowPrivateSources?: boolean },
) {
  const records = database.records<ModelRecord>('model_connections')

  function validateTarget(/* 当前解析后的提供方。 */ provider: string | null, /* 当前解析后的API地址。 */ baseUrl: string | null): void {
    // 第一版远端只使用官方HTTPS服务；本机测试端点需要显式装配例外。
    if (!baseUrl) return
    const url = new URL(baseUrl), official = provider ? new URL(defaults[provider]) : null
    const loopback = options.allowPrivateSources && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (loopback && ['http:', 'https:'].includes(url.protocol)) return
    if (!official || url.protocol !== 'https:' || url.origin !== official.origin || !['', '/', '/v1', '/v1/'].includes(url.pathname)) {
      throw new GraphError(400, 'INVALID_ARGUMENT', ModelConnectionMessage.INVALID_BASE_URL)
    }
  }

  async function readPair(/* 配置自身的归属。 */ scope: ModelScope, /* 与授权请求共享的存储会话。 */ session?: StorageSession | null) {
    // Agent缺省值只来自其本工作区，不读取共享库或服务器模型环境。
    const workspace = await records.get(recordId({ kind: 'workspace', workspaceId: scope.workspaceId }), session)
    const own = scope.kind === 'workspace' ? workspace : await records.get(recordId(scope), session)
    return { workspace, own }
  }

  function resolve(
    /* 本工作区保存的连接或未配置状态。 */ workspace: ModelRecord | null,
    /* 当前scope自己的连接或未配置状态。 */ own: ModelRecord | null,
    /* 已授权的配置层级。 */ scope: ModelScope,
  ): ResolvedConnection {
    // 跨提供方不继承模型和地址；同提供方逐字段继承。
    const provider = own?.provider ?? workspace?.provider ?? null
    const sameProvider = provider === workspace?.provider
    const model = own?.model ?? (sameProvider ? workspace?.model : null) ?? null
    const baseUrl = own?.baseUrl ?? (sameProvider ? workspace?.baseUrl : null) ?? (provider ? defaults[provider] : null) ?? null
    validateTarget(provider, baseUrl)
    const target = { provider, baseUrl }
    if (own?.secret && targetMatches(own.secret, target)) return { provider, model, baseUrl, key: own.secret, source: scope.kind === 'agent' ? 'agent' : 'workspace' }
    if (!own?.secret && workspace?.secret && targetMatches(workspace.secret, target)) return { provider, model, baseUrl, key: workspace.secret, source: 'workspace' }
    return { provider, model, baseUrl, key: null, source: null }
  }

  function view(
    /* 当前配置归属，不包含认证凭据。 */ scope: ModelScope,
    /* 当前scope原配置。 */ own: ModelRecord | null,
    /* 逐字段继承后的有效连接。 */ effective: ResolvedConnection,
  ): ModelConnectionView {
    // 只显式投影非秘密字段，不能把record或secret对象展开到公共返回值。
    return { scope: structuredClone(scope), revision: own?.revision ?? 0,
      provider: own?.provider ?? null, model: own?.model ?? null, baseUrl: own?.baseUrl ?? null,
      apiKeyConfigured: Boolean(own?.secret), effective: { provider: effective.provider, model: effective.model, baseUrl: effective.baseUrl,
        apiKeyConfigured: Boolean(effective.key), apiKeySource: effective.source } }
  }

  function openKey(/* 已验证目标的受限密文。 */ key: StoredKey): string {
    // 存储或密文错误使用固定提示，不传播底层异常、密文或主密钥。
    try {
      const value = options.modelSecrets?.open(key.ciphertext)
      if (typeof value !== 'string' || !value.trim()) throw new Error(ModelConnectionMessage.SECRETS_UNAVAILABLE)
      return value
    } catch { throw new GraphError(503, 'MODEL_SECRETS_UNAVAILABLE', ModelConnectionMessage.SECRETS_UNAVAILABLE) }
  }

  async function resolveWork(/* 受权工作区。 */ workspaceId: string, /* 受权Agent身份。 */ agentId: string, /* 当前可选事务。 */ session?: StorageSession | null): Promise<ModelWorkConfiguration> {
    // 仅在实际启动或领取工作时要求完整配置，读取空表单仍能正常工作。
    const scope: ModelScope = { kind: 'agent', workspaceId, agentId }, pair = await readPair(scope, session)
    const effective = resolve(pair.workspace, pair.own, scope)
    if (!effective.provider || !effective.model || !effective.baseUrl || !effective.key) throw new GraphError(422, 'MODEL_CONFIGURATION_MISSING', ModelConnectionMessage.CONFIGURATION_MISSING)
    return { provider: effective.provider, model: effective.model, baseUrl: effective.baseUrl, apiKey: openKey(effective.key) }
  }

  return {
    async initialize(): Promise<void> {
      // 集合主键保证scope唯一，工作区索引便于后续范围清理。
      await records.index(['workspaceId'])
    },
    async read(/* 已由Control检查成员资格的scope。 */ scope: ModelScope, /* 同一授权读取会话。 */ session?: StorageSession | null): Promise<ModelConnectionView> {
      const pair = await readPair(scope, session)
      return view(scope, pair.own, resolve(pair.workspace, pair.own, scope))
    },
    async update(
      /* 已由Control检查owner权限的scope。 */ scope: ModelScope,
      /* 此scope独立的预期版本。 */ expectedRevision: number,
      /* 已严格解析的字段与三态密钥变更。 */ configuration: ModelConnectionInput,
      /* 当前写入者和稳定请求编号，只保存输入摘要。 */ request: { userId: string; requestId: string },
      /* 与owner授权共享、必须仍在事务中的会话。 */ session: StorageSession,
    ): Promise<{ data: ModelConnectionView; replayed: boolean }> {
      const pair = await readPair(scope, session), prior = pair.own
      const hash = storeCreateInputHash({ scope, expectedRevision, configuration })
      const receipt = prior?.receipts.find(item => item.userId === request.userId && item.requestId === request.requestId)
      if (receipt) {
        if (receipt.hash !== hash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', ModelConnectionMessage.REVISION_CONFLICT)
        return { data: view(scope, prior, resolve(pair.workspace, prior, scope)), replayed: true }
      }
      if ((prior?.revision ?? 0) !== expectedRevision) throw new GraphError(409, 'REVISION_CONFLICT', ModelConnectionMessage.REVISION_CONFLICT, prior?.revision ?? 0)
      const next: ModelRecord = { _id: recordId(scope), workspaceId: scope.workspaceId, scope: structuredClone(scope),
        provider: configuration.provider, model: configuration.model, baseUrl: configuration.baseUrl,
        revision: expectedRevision + 1, secret: configuration.apiKey === null ? null : prior?.secret ?? null,
        receipts: [...(prior?.receipts ?? []), { ...request, hash }] }
      const workspace = scope.kind === 'workspace' ? next : pair.workspace
      const target = resolve(workspace, next, scope)
      if (configuration.apiKey !== undefined && configuration.apiKey !== null) {
        if (!target.provider || !target.baseUrl) throw new GraphError(400, 'MODEL_CONFIGURATION_MISSING', ModelConnectionMessage.CONFIGURATION_MISSING)
        if (!options.modelSecrets) throw new GraphError(503, 'MODEL_SECRETS_UNAVAILABLE', ModelConnectionMessage.SECRETS_UNAVAILABLE)
        next.secret = { provider: target.provider, baseUrl: target.baseUrl, ciphertext: options.modelSecrets.seal(configuration.apiKey) }
      } else if (next.secret && !targetMatches(next.secret, target)) {
        throw new GraphError(400, 'MODEL_KEY_TARGET_CHANGED', ModelConnectionMessage.KEY_TARGET_CHANGED)
      }
      if (prior) {
        const changed = await records.change(next._id, current => current.revision === expectedRevision ? next : null, session)
        if (!changed) throw new GraphError(409, 'REVISION_CONFLICT', ModelConnectionMessage.REVISION_CONFLICT)
      } else await records.insert(next, session)
      return { data: view(scope, next, resolve(scope.kind === 'workspace' ? next : workspace, next, scope)), replayed: false }
    },
    resolveWork,
    async readWork(
      /* 由调用方用当前Work proof验证过的工作区。 */ workspaceId: string,
      /* 当前Work的冻结非秘密模型资料。 */ profile: GraphAgentProfile,
      /* 可选同一存储会话。 */ session?: StorageSession | null,
    ): Promise<ModelWorkConfiguration> {
      const current = await resolveWork(workspaceId, profile.id, session)
      const baseUrl = 'baseUrl' in profile && typeof profile.baseUrl === 'string' ? profile.baseUrl : defaults[profile.provider]
      if (current.provider !== profile.provider || current.baseUrl !== baseUrl) throw new GraphError(409, 'MODEL_TARGET_CHANGED', ModelConnectionMessage.FROZEN_TARGET_CHANGED)
      return { ...current, model: profile.model }
    },
  }
}
