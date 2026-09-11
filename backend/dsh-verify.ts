import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DshEvent, DshRuntimeAPI } from '../contracts/dsh'
import type { GraphAgentProfile, GraphDataRead, GraphWorkGrant } from '../contracts/graph'
import { dshCreateRuntime } from './dsh'
import { promptReadWork } from './prompt'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
  constructor(message: string) {
    super(message)
    this.name = 'WorkAccessError'
  }
}

async function dshReadWorkReply<T>(
  input: DshWorkInput,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  input.signal?.throwIfAborted()
  const url = new URL(path, input.dataApiUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Data API must use HTTP(S)')
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
    throw new WorkAccessError('Work API connection could not be confirmed')
  }
  const unavailable = response.status >= 500 || response.status === 429
  let result
  try { result = await response.json() }
  catch (error) {
    input.signal?.throwIfAborted()
    if (unavailable || !(error instanceof SyntaxError)) throw new WorkAccessError('Work API response could not be received')
    throw new Error('Work API returned invalid JSON')
  }
  if (!response.ok || result?.ok !== true) {
    const message = result?.error?.code ? result.error.code + ': ' + result.error.message : 'Work API returned ' + response.status
    if (unavailable || result?.error?.code === 'LEASE_LOST') throw new WorkAccessError(message)
    throw new Error(message)
  }
  return result.data as T
}

async function dshReadWorkStatus(input: DshWorkInput): Promise<'ready' | 'accepted'> {
  const grant = input.grant
  const data = await dshReadWorkReply<{ workId: string; status: 'ready' | 'accepted' }>(input, '/internal/v1/work', {
    method: 'read',
    params: { mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence },
  })
  if (data?.workId !== grant.workId || !['ready', 'accepted'].includes(data.status)) throw new Error('Work API returned another or invalid work status')
  return data.status
}

async function dshReadWork(input: DshWorkInput): Promise<GraphDataRead> {
  const grant = input.grant
  const data = await dshReadWorkReply<GraphDataRead>(input, '/internal/v1/data/read', {
    mapId: grant.mapId, operationId: grant.operationId,
  }, {
    'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence),
  })
  if (data.mapId !== grant.mapId || data.runId !== grant.runId || data.operationId !== grant.operationId
    || data.work?.id !== grant.workId || data.work.routeRevision !== grant.routeRevision
    || JSON.stringify(data.work.actor) !== JSON.stringify(grant.actor)) throw new Error('Data API returned another work grant')
  return data
}

function dshReadWorkProfile(data: GraphDataRead, grant: GraphWorkGrant): GraphAgentProfile {
  if (grant.actor.role === 'router') return data.configuration.router
  if (!data.route?.approved || data.route.revision !== grant.routeRevision) throw new Error('Work has no matching approved route')
  if (grant.actor.role !== 'worker') return data.configuration.merger
  const slotId = grant.actor.slotId
  const slot = data.route.slots.find(slot => slot.id === slotId)
  const profile = data.configuration.agents.find(agent => agent.id === slot?.agentId)
  if (!slot || !profile || slot.tools.some(tool => !profile.tools.includes(tool))) throw new Error('Worker has no valid configured slot')
  return profile
}

/** One accepted work grant owns one DSH process. The caller owns claim, renew and release. */
export async function dshRunWork(options: DshWorkInput): Promise<DshWorkResult> {
  const input = { ...options, grant: structuredClone(options.grant) }
  const grant = input.grant
  input.signal?.throwIfAborted()
  if (!input.token.trim()) throw new Error('CHONGMING_DATA_TOKEN must be configured')
  if (!grant?.workId || !grant.holderId || !Number.isSafeInteger(grant.fence) || grant.fence < 1) throw new Error('A claimed work grant is required')
  const maxRounds = input.maxRounds ?? 3
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new Error('maxRounds must be an integer from 1 to 10')
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
    if (!runtime) return Promise.resolve()
    return closePromise ??= runtime.close()
  }
  const abort = () => { void dshCloseWork().catch(() => {}) }
  try {
    input.signal?.throwIfAborted()
    const patchPath = path.join(patchDir, 'work.patch.yml')
    // The token remains in the environment; the immutable grant never enters model arguments.
    await writeFile(patchPath, JSON.stringify([
      { id: 'chongming-data-tools', config: { grant, rootSessionId, configuration: data.configuration, route: data.route, persona: prompt } },
      { id: 'sdk-jsonrpc-server', config: { maxTokensAsSuccess: false } },
    ], null, 2), { mode: 0o600 })
    input.signal?.throwIfAborted()
    runtime = dshCreateRuntime({
      dshBin: input.dshBin ?? path.join(projectRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      dshHome,
      cwd: path.resolve(input.cwd ?? projectRoot),
      processCwd: path.resolve(input.processCwd ?? dshHome),
      profile: 'sdk',
      patches: [path.join(projectRoot, 'backend/dsh-business.patch.yml'), ...(input.patches ?? []), patchPath],
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
    throw new Error('DSH stopped without submitting this work after ' + maxRounds + ' turns')
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error
    throw error
  } finally {
    input.signal?.removeEventListener('abort', abort)
    try { await dshCloseWork() } finally { await rm(patchDir, { recursive: true, force: true }) }
  }
}
