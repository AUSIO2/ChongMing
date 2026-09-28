// 文件职责：为单份已领取工作建立隔离 DSH 进程，并核对服务端提交结果。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DshEvent, DshRuntimeAPI } from '../../../contracts/dsh'
import type { GraphAgentProfile, GraphDataRead, GraphWorkGrant } from '../../../contracts/graph'
import { dshCreateRuntime } from './runtime'
import { promptReadWork } from './prompt-renderer'

const businessPatch = fileURLToPath(new URL('./dsh-business.patch.yml', import.meta.url))

export interface DshWorkInput {
  // 调用方负责领取、续租与释放；本执行器只使用授权副本运行一个根会话。
  grant: GraphWorkGrant
  dataApiUrl: string
  token: string
  dshHome: string
  signal?: AbortSignal
  dshBin?: string
  cwd?: string
  processCwd?: string
  /** Trusted deployment patches may register custom tools and model providers. */
  patches?: string[]
  env?: Record<string, string | undefined>
  maxTokens?: number
  /** Bounded follow-up turns if the Agent stops before submitting this work's result. */
  maxRounds?: number
  // 同步接收经过 JSON 复制的本次执行事件。
  onEvent?: (/* 经过 JSON 复制的单条 DSH 执行通知，供外部活动观察者使用。 */ event: DshEvent) => void
}

export interface DshWorkResult {
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
  constructor(/* 解释工作 API 或租约暂时无法确认的错误文本。 */ message: string) {
    // 标记数据访问或租约确认暂时失败，供 Host 区分于模型执行失败。
    super(message)
    this.name = 'WorkAccessError'
  }
}
async function dshReadWorkReply<T>(
  /* 当前工作的可信授权、内部令牌、API 地址及取消信号。 */ input: DshWorkInput,
  /* 相对于数据 API 的内部接口路径，由执行器固定选择。 */ path: string,
  /* 与该内部接口对应的请求载荷，发送前序列化为 JSON。 */ body: unknown,
  /* 可选额外请求头，默认空对象，读取输入时用于携带租约凭证。 */ headers: Record<string, string> = {},
): Promise<T> {
  // 携带内部令牌调用工作 API，并区分暂时不可访问与明确协议错误。
  input.signal?.throwIfAborted()
  const url = new URL(path, input.dataApiUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(RuntimeMessage.DATA_API_MUST_USE_HTTP_S)
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
  let result
  try { result = await response.json() }
  catch (error) {
    input.signal?.throwIfAborted()
    if (unavailable || !(error instanceof SyntaxError)) throw new WorkAccessError(RuntimeMessage.WORK_API_RESPONSE_COULD_NOT_BE_RECEIVED)
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
async function dshReadWorkStatus(/* 本次执行的工作配置，授权身份用于查询结果是否已被接纳。 */ input: DshWorkInput): Promise<'ready' | 'accepted'> {
  // 查询指定授权的提交状态，拒绝返回其他工作或未知状态。
  const grant = input.grant
  const data = await dshReadWorkReply<{ workId: string; status: 'ready' | 'accepted' }>(input, '/internal/v1/work', {
    method: 'read',
    params: { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence },
  })
  if (data?.workId !== grant.workId || !['ready', 'accepted'].includes(data.status)) throw new Error(RuntimeMessage.WORK_API_RETURNED_ANOTHER_OR_INVALID_WORK_STATUS)
  return data.status
}
async function dshReadWork(/* 本次已领取工作配置，决定数据读取范围与须匹配的返回身份。 */ input: DshWorkInput): Promise<GraphDataRead> {
  // 读取授权输入并逐项核对 Run、Operation、角色、路由版本及目标类型。
  const grant = input.grant
  const data = await dshReadWorkReply<GraphDataRead>(input, '/internal/v1/data/read', {
    mapId: grant.mapId, operationId: grant.operationId,
  }, {
    'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence),
  })
  if (data.mapId !== grant.mapId || data.runId !== grant.runId || data.operationId !== grant.operationId
    || data.work?.id !== grant.workId || data.work.routeRevision !== grant.routeRevision
    || JSON.stringify(data.work.actor) !== JSON.stringify(grant.actor)) throw new Error(RuntimeMessage.DATA_API_RETURNED_ANOTHER_WORK_GRANT)
  const targetKind = { parse: 'source', split: 'news', verify: 'claim' }[data.operationKind]
  if (!targetKind || data.target?.data.kind !== targetKind || !data.proposalId
    || (data.operationKind === 'parse' && typeof data.rawContent !== 'string')) throw new Error(RuntimeMessage.DATA_API_RETURNED_INVALID_OPERATION_INPUT)
  return data
}
function dshReadWorkProfile(/* 从 API 读取并已核对工作身份的执行视图，包含冻结配置与批准路由。 */ data: GraphDataRead, /* 当前执行授权，角色与槽位决定采用哪个 Agent 配置。 */ grant: GraphWorkGrant): GraphAgentProfile {
  // 根据冻结配置和工作角色选择 Agent，检查 worker 槽位与工具授权。
  if (data.operationKind === 'parse') {
    if (grant.actor.role !== 'parse' || !data.configuration.parse) throw new Error(RuntimeMessage.PARSE_WORK_HAS_NO_CONFIGURED_PARSER)
    return data.configuration.parse
  }
  if (grant.actor.role === 'parse') throw new Error(RuntimeMessage.PARSER_CANNOT_EXECUTE_ANOTHER_OPERATION)
  const configuration = data.operationKind === 'split' ? data.configuration.split : data.configuration
  if (!configuration) throw new Error(RuntimeMessage.SPLIT_WORK_HAS_NO_CONFIGURED_AGENTS)
  if (grant.actor.role === 'router') return configuration.router
  if (!data.route?.approved || data.route.revision !== grant.routeRevision) throw new Error(RuntimeMessage.WORK_HAS_NO_MATCHING_APPROVED_ROUTE)
  if (grant.actor.role !== 'worker') return configuration.merger
  const slotId = grant.actor.slotId
  const slot = data.route.slots.find(/* 批准路由中的候选槽位，与当前 worker 的 slotId 比较。 */ slot => /* 查找工作授权绑定的路由槽位。 */  slot.id === slotId)
  const profile = configuration.agents.find(/* 本 Run 冻结配置中的 Agent，与槽位指定身份比较。 */ agent => /* 取得该槽位指定的冻结 Agent 配置。 */  agent.id === slot?.agentId)
  if (!slot || !profile || slot.tools.some(/* 路由槽位请求的工具名，必须包含在所选 Agent 的能力集合中。 */ tool => /* 检查路由所选工具是否超出 Agent 的能力集合。 */  !profile.tools.includes(tool))) throw new Error(RuntimeMessage.WORKER_HAS_NO_VALID_CONFIGURED_SLOT)
  return profile
}

/** One accepted work grant owns one DSH process. The caller owns claim, renew and release. */
export async function dshRunWork(/* 调用方提供的单工作配置；执行器复制 grant，管理临时补丁和 DSH 进程。 */ options: DshWorkInput): Promise<DshWorkResult> {
  // 为未完成工作启动独立 DSH 会话，有限追问直到收据确认，最终关闭进程并清理临时补丁。
  const input = { ...options, grant: structuredClone(options.grant) }
  const grant = input.grant
  input.signal?.throwIfAborted()
  if (!input.token.trim()) throw new Error(RuntimeMessage.CHONGMING_DATA_TOKEN_MUST_BE_CONFIGURED)
  if (!grant?.workId || !grant.holderId || !Number.isSafeInteger(grant.fence) || grant.fence < 1) throw new Error(RuntimeMessage.A_CLAIMED_WORK_GRANT_IS_REQUIRED)
  const maxRounds = input.maxRounds ?? 3
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new Error(RuntimeMessage.MAXROUNDS_MUST_BE_AN_INTEGER_FROM_1_TO_10)
  const resultBase = { workId: grant.workId, mapId: grant.mapId, runId: grant.runId, operationId: grant.operationId, status: 'accepted' as const }
  if (await dshReadWorkStatus(input) === 'accepted') return { ...resultBase, sessionId: null, finalResponse: '' }
  const data = await dshReadWork(input)
  const profile = dshReadWorkProfile(data, grant)
  const prompt = promptReadWork(profile, data, grant)
  const rootSessionId = randomUUID()
  const dshHome = path.resolve(input.dshHome)
  await mkdir(dshHome, { recursive: true })
  const patchDir = await mkdtemp(path.join(dshHome, 'work-'))
  let runtime: DshRuntimeAPI | undefined
  let closePromise: Promise<void> | undefined
  function dshCloseWork(): Promise<void> {
    // 幂等关闭已创建的工作运行时，尚未创建时立即完成。
    if (!runtime) return Promise.resolve()
    return closePromise ??= runtime.close()
  }
  const abort = () => {
    // 工作取消时立即触发运行时关闭，不阻塞取消事件处理。
     void dshCloseWork().catch(() => {
    // 取消回调不传播关闭异常；主流程 finally 仍会等待同一关闭 Promise。
  }) }
  try {
    input.signal?.throwIfAborted()
    const patchPath = path.join(patchDir, 'work.patch.yml')
    // The token remains in the environment; the immutable grant never enters model arguments.
    await writeFile(patchPath, JSON.stringify([
      { id: 'chongming-data-tools', config: { grant, rootSessionId, operationKind: data.operationKind,
        proposalId: data.proposalId, configuration: data.configuration, route: data.route, persona: prompt } },
      { id: 'sdk-jsonrpc-server', config: { maxTokensAsSuccess: false } },
    ], null, 2), { mode: 0o600 })
    input.signal?.throwIfAborted()
    runtime = dshCreateRuntime({
      dshBin: input.dshBin,
      dshHome,
      cwd: path.resolve(input.cwd ?? process.cwd()),
      processCwd: path.resolve(input.processCwd ?? dshHome),
      profile: 'sdk',
      patches: [businessPatch, ...(input.patches ?? []), patchPath],
      provider: profile.provider, model: profile.model, maxTokens: input.maxTokens,
      env: { ...input.env, CHONGMING_DATA_API: input.dataApiUrl, CHONGMING_DATA_TOKEN: input.token },
    })
    input.signal?.addEventListener('abort', abort, { once: true })
    input.signal?.throwIfAborted()
    await runtime.start()
    for (let round = 0; round < maxRounds; round++) {
      input.signal?.throwIfAborted()
      const result = await runtime.run({ sessionId: rootSessionId, prompt }, input.onEvent)
      if (await dshReadWorkStatus(input) === 'accepted') return { ...resultBase, sessionId: result.sessionId, finalResponse: result.finalResponse }
    }
    throw new Error(messageFormat(RuntimeMessage.DSH_STOPPED_WITHOUT_SUBMITTING_THIS_WORK_AFTER_VALUE_TURNS, maxRounds))
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error
    throw error
  } finally {
    input.signal?.removeEventListener('abort', abort)
    try { await dshCloseWork() } finally { await rm(patchDir, { recursive: true, force: true }) }
  }
}
