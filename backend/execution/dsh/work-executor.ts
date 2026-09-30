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
  onEvent?: (event: DshEvent) => void
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
  /**
   * 标记数据访问或租约确认暂时失败，供 Host 区分于模型执行失败。
   *
   * @param message 解释工作 API 或租约暂时无法确认的错误文本。
   */
  constructor(message: string) {
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
async function dshReadWorkReply<T>(
  input: DshWorkInput,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
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
/**
 * 查询指定授权的提交状态，拒绝返回其他工作或未知状态。
 *
 * @param input 本次执行的工作配置，授权身份用于查询结果是否已被接纳。
 */
async function dshReadWorkStatus(input: DshWorkInput): Promise<'ready' | 'accepted'> {
  const grant = input.grant
  const data = await dshReadWorkReply<{ workId: string; status: 'ready' | 'accepted' }>(input, '/internal/v1/work', {
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
async function dshReadWork(input: DshWorkInput): Promise<GraphDataRead> {
  const grant = input.grant
  const data = await dshReadWorkReply<GraphDataRead>(input, '/internal/v1/data/read', {
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
 * 使用数据服务返回的冻结阶段 Agent，拒绝阶段工具超出该配置能力或身份与授权不符。
 *
 * @param data 从 API 读取并已核对工作身份的执行视图，包含冻结配置与批准路由。
 * @param grant 当前执行授权，角色与槽位决定采用哪个 Agent 配置。
 */
function dshReadWorkProfile(data: GraphDataRead, grant: GraphWorkGrant): GraphAgentProfile {
  if (data.stage.id !== grant.stageId || data.stage.slotId !== grant.slotId) throw new Error(RuntimeMessage.DATA_API_RETURNED_ANOTHER_WORK_GRANT)
  const profile = data.stage.agent.profile
  if (!profile || data.stage.tools.some(tool =>
    /* 检查该阶段工具是否超出 Agent 配置。 */ !profile.tools.includes(tool.name))) {
    throw new Error(RuntimeMessage.WORKER_HAS_NO_VALID_CONFIGURED_SLOT)
  }
  return profile
}

/** One accepted work grant owns one DSH process. The caller owns claim, renew and release. */
/**
 * 为未完成工作启动独立 DSH 会话与可写目录，有限追问直到收据确认，最终关闭进程并清理本次尝试。
 *
 * @param options 调用方提供的单工作配置；执行器复制 grant，管理临时补丁和 DSH 进程。
 */
export async function dshRunWork(options: DshWorkInput): Promise<DshWorkResult> {
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
  const attemptHome = await mkdtemp(path.join(dshHome, 'attempt-'))
  let attemptProcessDirectory = path.join(attemptHome, 'process')
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
    if (input.processCwd) {
      const processRoot = path.resolve(input.processCwd)
      await mkdir(processRoot, { recursive: true })
      attemptProcessDirectory = await mkdtemp(path.join(processRoot, '.chongming-attempt-'))
    } else await mkdir(attemptProcessDirectory, { recursive: true })
    const patchPath = path.join(attemptHome, 'work.patch.yml')
    // The token remains in the environment; the immutable grant never enters model arguments.
    await writeFile(patchPath, JSON.stringify([
      { id: 'chongming-data-tools', config: { grant, rootSessionId,
        proposalId: data.proposalId, specHash: data.specHash, stage: data.stage,
        outputContract: data.outputContract, persona: prompt } },
      { id: 'sdk-jsonrpc-server', config: { maxTokensAsSuccess: false } },
    ], null, 2), { mode: 0o600 })
    input.signal?.throwIfAborted()
    runtime = dshCreateRuntime({
      dshBin: input.dshBin,
      dshHome: attemptHome,
      cwd: path.resolve(input.cwd ?? process.cwd()),
      processCwd: attemptProcessDirectory,
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
    try { await dshCloseWork() } finally {
      // 仅在 DSH 子进程确认关闭后删除本次尝试的 Home 与进程目录，绝不触碰其他并行尝试。
      const directories = attemptProcessDirectory.startsWith(attemptHome + path.sep)
        ? [attemptHome] : [attemptHome, attemptProcessDirectory]
      // 递归删除本次尝试目录；不存在时视为已完成清理。
      await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
    }
  }
}
