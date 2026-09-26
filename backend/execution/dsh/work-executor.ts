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
  // 用途：初始化WorkAccessError实例。
  constructor(message: string) {
    super(message)
    this.name = 'WorkAccessError'
  }
}

// 用途：读取工作响应，并把结构化结果交给调用方。
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

// 用途：读取工作状态，并把结构化结果交给调用方。
async function dshReadWorkStatus(input: DshWorkInput): Promise<'ready' | 'accepted'> {
  const grant = input.grant
  const data = await dshReadWorkReply<{ workId: string; status: 'ready' | 'accepted' }>(input, '/internal/v1/work', {
    method: 'read',
    params: { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence },
  })
  if (data?.workId !== grant.workId || !['ready', 'accepted'].includes(data.status)) throw new Error(RuntimeMessage.WORK_API_RETURNED_ANOTHER_OR_INVALID_WORK_STATUS)
  return data.status
}

// 用途：读取工作，并把结构化结果交给调用方。
async function dshReadWork(input: DshWorkInput): Promise<GraphDataRead> {
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

// 用途：读取工作配置，并把结构化结果交给调用方。
function dshReadWorkProfile(data: GraphDataRead, grant: GraphWorkGrant): GraphAgentProfile {
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
  const slot = data.route.slots.find(slot => slot.id === slotId)
  const profile = configuration.agents.find(agent => agent.id === slot?.agentId)
  if (!slot || !profile || slot.tools.some(tool => !profile.tools.includes(tool))) throw new Error(RuntimeMessage.WORKER_HAS_NO_VALID_CONFIGURED_SLOT)
  return profile
}

/** One accepted work grant owns one DSH process. The caller owns claim, renew and release. */
// 用途：执行工作流程，并返回执行结果。
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
  const patchDir = await mkdtemp(path.join(dshHome, 'work-'))
  let runtime: DshRuntimeAPI | undefined
  let closePromise: Promise<void> | undefined
  // 用途：关闭工作，并释放相关资源。
  function dshCloseWork(): Promise<void> {
    if (!runtime) return Promise.resolve()
    return closePromise ??= runtime.close()
  }
  const abort = () => { void dshCloseWork().catch(() => {}) }
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
