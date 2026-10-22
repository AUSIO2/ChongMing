// 两种工作执行器共用的受权API读取；Host仍拥有领取、续租和释放。
import { RuntimeMessage, messageFormat } from '../../contracts/messages'
import type { GraphAgentProfile } from '../../contracts/graph-agent'
import type { GraphDataRead, GraphWorkGrant } from '../../contracts/graph-work'
import { ModelConnectionMessage, type ModelWorkConfiguration } from '../../contracts/model-connection'

export interface WorkApiInput {
  // Host已经取得的本份工作授权，模型进程不接收其内部凭据。
  grant: GraphWorkGrant
  dataApiUrl: string
  token: string
  signal?: AbortSignal
}

export interface WorkRunResult {
  workId: string
  mapId: string
  runId: string
  operationId: string
  sessionId: string | null
  status: 'accepted'
  finalResponse: string
}

/** Temporary loss of the data/lease authority, not a model or configuration failure. */
export class WorkAccessError extends Error {
  /**
   * 标记数据访问或租约确认暂时失败，供 Host 区分于模型执行失败。
   *
   * @param message 解释工作 API 或租约暂时无法确认的错误文本。
   */
  constructor(/* 已明确分类的工作API或租约失败原因。 */ message: string) {
    // 保留Host已有的临时访问失败分类，不把它当模型执行失败。
    super(message)
    this.name = 'WorkAccessError'
  }
}
/**
 * 携带内部令牌调用工作 API，并区分暂时不可访问与明确协议错误。
 *
 * @param input 当前工作的可信授权、内部令牌、API 地址及取消信号。
 * @param path 相对于数据 API 的内部接口路径，由执行器固定选择。
 * @param body 与该内部接口对应的请求载荷，发送前序列化为 JSON。
 * @param headers 可选额外请求头，默认空对象，读取输入时用于携带租约凭证。
 */
export async function workReadReply<T>(
  /* 已领取工作的端点、凭据和取消生命周期。 */ input: WorkApiInput,
  /* 工作 API 内的固定路由。 */ path: string,
  /* 本次读取或提交使用的实际业务载荷。 */ body: unknown,
  /* 当前 Work 的身份与隔离栅栏请求头。 */ headers: Record<string, string> = {},
): Promise<T> {
  // 网络读流失败保留可重试访问错误；完整字节的非法编码或 JSON 属于响应协议错误。
  input.signal?.throwIfAborted()
  const url = new URL(path, input.dataApiUrl)
  const request = new Request(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', authorization: 'Bearer ' + input.token },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  let response: Response
  try { response = await fetch(request) }
  catch {
    input.signal?.throwIfAborted()
    throw new WorkAccessError(RuntimeMessage.WORK_API_CONNECTION_COULD_NOT_BE_CONFIRMED)
  }
  const unavailable = response.status >= 500 || response.status === 429
  let bytes: ArrayBuffer
  try { bytes = await response.arrayBuffer() }
  catch {
    input.signal?.throwIfAborted()
    throw new WorkAccessError(RuntimeMessage.WORK_API_RESPONSE_COULD_NOT_BE_RECEIVED)
  }
  let result
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch {
    input.signal?.throwIfAborted()
    if (unavailable) throw new WorkAccessError(RuntimeMessage.WORK_API_RESPONSE_COULD_NOT_BE_RECEIVED)
    throw new Error(RuntimeMessage.WORK_API_RETURNED_INVALID_JSON)
  }
  if (!response.ok || result?.ok !== true) {
    const message = result?.error?.code
      ? messageFormat(RuntimeMessage.REMOTE_ERROR_WITH_CODE, result.error.code, result.error.message)
      : messageFormat(RuntimeMessage.WORK_API_RETURNED_HTTP_STATUS, response.status)
    if (unavailable || result?.error?.code === 'LEASE_LOST') throw new WorkAccessError(message)
    throw new Error(message)
  }
  return result.data as T
}
/**
 * 查询指定授权的提交状态，拒绝返回其他工作或未知状态。
 *
 * @param input 本次执行的工作配置，授权身份用于查询结果是否已被接纳。
 */
export async function workReadStatus(/* 本份已领取工作的API身份与取消生命周期。 */ input: WorkApiInput): Promise<'ready' | 'accepted'> {
  // 使用原Work proof确认接受状态，不能只凭模型自然语言或进程退出判断。
  const grant = input.grant
  const data = await workReadReply<{ workId: string; status: 'ready' | 'accepted' }>(input, '/internal/v1/work', {
    method: 'read',
    params: { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence },
  })
  if (data?.workId !== grant.workId || !['ready', 'accepted'].includes(data.status)) throw new Error(RuntimeMessage.WORK_API_RETURNED_ANOTHER_OR_INVALID_WORK_STATUS)
  return data.status
}
/**
 * 读取授权输入并逐项核对 Run、Operation、阶段、槽位及冻结执行规格。
 *
 * @param input 本次已领取工作配置，决定数据读取范围与须匹配的返回身份。
 */
export async function workReadData(/* 本份已领取工作的API身份与取消生命周期。 */ input: WorkApiInput): Promise<GraphDataRead> {
  // 只接收与原Work、槽位和冻结规格完全对应的授权视图。
  const grant = input.grant
  const data = await workReadReply<GraphDataRead>(input, '/internal/v1/data/read', {
    mapId: grant.mapId, operationId: grant.operationId,
  }, {
    'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence),
  })
  if (data.mapId !== grant.mapId || data.runId !== grant.runId || data.operationId !== grant.operationId
    || data.specHash !== grant.specHash || data.work?.id !== grant.workId
    || data.work.stageId !== grant.stageId || data.work.slotId !== grant.slotId || data.work.specHash !== grant.specHash
    || data.stage?.id !== grant.stageId || data.stage.slotId !== grant.slotId || !data.proposalId) {
    throw new Error(RuntimeMessage.DATA_API_RETURNED_ANOTHER_WORK_GRANT)
  }
  return data
}
/**
 * 使用已核对身份的冻结阶段 Agent，拒绝阶段工具超出该配置能力。
 *
 * @param data 从 API 读取并已核对工作身份的执行视图，包含冻结配置与批准路由。
 */
export function workReadProfile(
  /* 工作服务已确认身份的冻结阶段配置。 */ data: GraphDataRead,
): GraphAgentProfile {
  // 取得当前阶段的Agent配置，并确认本阶段工具都属于其批准能力。
  const profile = data.stage.agent.profile
  if (!profile || data.stage.tools.some((/* 本阶段获准使用的一项工具。 */ tool) =>
    /* 检查该阶段工具是否超出 Agent 配置。 */ !profile.tools.includes(tool.name))) {
    throw new Error(RuntimeMessage.WORKER_HAS_NO_VALID_CONFIGURED_SLOT)
  }
  return profile
}

export async function workReadModel(
  /* 本份已领取工作的内部API和租约身份。 */ input: WorkApiInput,
  /* 已经过工作身份核对、不含密钥的冻结数据。 */ data: GraphDataRead,
): Promise<ModelWorkConfiguration> {
  // 单独交付凭据，不把Key放入data_read、提示词或执行规格。
  const grant = input.grant, profile = workReadProfile(data)
  if (data.mapId !== grant.mapId || data.runId !== grant.runId || data.operationId !== grant.operationId
    || data.specHash !== grant.specHash || data.work.id !== grant.workId) throw new Error(RuntimeMessage.DATA_API_RETURNED_ANOTHER_WORK_GRANT)
  if (!profile.baseUrl) throw new Error(ModelConnectionMessage.CONFIGURATION_MISSING)
  const value = await workReadReply<unknown>(input, '/internal/v1/model/read', { mapId: grant.mapId, operationId: grant.operationId }, {
    'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence),
  })
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(ModelConnectionMessage.CONFIGURATION_MISSING)
  const fields = value as Record<string, unknown>
  if (typeof fields.apiKey !== 'string' || !fields.apiKey.trim()) throw new Error(ModelConnectionMessage.CONFIGURATION_MISSING)
  if (fields.provider !== profile.provider || fields.model !== profile.model || fields.baseUrl !== profile.baseUrl) {
    throw new Error(ModelConnectionMessage.FROZEN_TARGET_CHANGED)
  }
  return { provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, apiKey: fields.apiKey }
}

export function workCreateModelEnvironment(
  /* 父进程与可信运行参数合并的环境；此对象本身不被修改。 */ source: Record<string, string | undefined>,
  /* 本Work从受权接口取得的唯一模型凭据。 */ connection: ModelWorkConfiguration,
): Record<string, string | undefined> {
  // 工具Key与工作授权各有独立用途，模型Key、地址和CLI缓存入口不能从父进程继承。
  const env = Object.fromEntries(Object.entries(source).filter(([name]) =>
    name === 'TAVILY_API_KEY' || name === 'CHONGMING_DATA_TOKEN' || (!/(?:^|_)(?:API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|BASE_URL)$/.test(name)
      && !/^(?:OPENAI|DEEPSEEK|ANTHROPIC|AZURE_OPENAI|GEMINI|GOOGLE_GENERATIVE_AI|CODEX)_/.test(name))))
  env.CHONGMING_MODEL_API_KEY = connection.apiKey
  if (connection.provider === 'deepseek-official') {
    env.DEEPSEEK_API_KEY = connection.apiKey
    env.DEEPSEEK_BASE_URL = connection.baseUrl
  }
  return env
}

