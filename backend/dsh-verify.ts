import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DshEvent, DshRuntimeAPI } from '../contracts/dsh'
import type { GraphDataRead } from '../contracts/graph'
import { dshCreateRuntime } from './dsh'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface DshVerifyInput {
  mapId: string
  operationId: string
  rootSessionId?: string
  dataApiUrl: string
  token: string
  dshHome: string
  dshBin?: string
  cwd?: string
  processCwd?: string
  /** Trusted deployment patches may register custom tools and model providers. */
  patches?: string[]
  env?: Record<string, string | undefined>
  maxTokens?: number
  /** Bounded follow-up turns when the root stops before the operation reaches a business boundary. */
  maxRounds?: number
  onEvent?: (event: DshEvent) => void
}

export interface DshVerifyResult {
  mapId: string
  runId: string
  operationId: string
  sessionId: string | null
  phase: 'waiting' | 'done'
  finalResponse: string
}

async function dshReadVerification(input: DshVerifyInput): Promise<GraphDataRead> {
  const response = await fetch(new URL('/internal/v1/data/read', input.dataApiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + input.token, 'x-dsh-role': 'router' },
    body: JSON.stringify({ mapId: input.mapId, operationId: input.operationId }),
  })
  const result = await response.json()
  if (!response.ok || result.ok !== true) throw new Error(result.error?.message ?? 'Data API returned ' + response.status)
  const data = result.data as GraphDataRead
  if (data.mapId !== input.mapId || data.operationId !== input.operationId) throw new Error('Data API returned another operation')
  return data
}

/** Execute one already-registered operation. No Graph creation, claim loop or global scheduler. */
export async function dshRunVerification(input: DshVerifyInput): Promise<DshVerifyResult> {
  if (!input.token.trim()) throw new Error('CHONGMING_DATA_TOKEN must be configured')
  if (!input.mapId || !input.operationId) throw new Error('mapId and operationId are required')
  const maxRounds = input.maxRounds ?? 3
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new Error('maxRounds must be an integer from 1 to 10')
  let data = await dshReadVerification(input)
  if (data.phase === 'waiting' || data.phase === 'done') {
    return { mapId: input.mapId, runId: data.runId, operationId: input.operationId, sessionId: null, phase: data.phase, finalResponse: '' }
  }
  const rootSessionId = input.rootSessionId ?? randomUUID()
  const dshHome = path.resolve(input.dshHome)
  await mkdir(dshHome, { recursive: true })
  const patchDir = await mkdtemp(path.join(dshHome, 'verification-'))
  const patchPath = path.join(patchDir, 'operation.patch.yml')
  let runtime: DshRuntimeAPI | undefined
  try {
    // JSON is valid YAML. Only non-secret configuration is written to the per-invocation patch.
    await writeFile(patchPath, JSON.stringify([
      {
        id: 'chongming-data-tools',
        config: { mapId: input.mapId, operationId: input.operationId, rootSessionId, configuration: data.configuration },
      },
      { id: 'sdk-jsonrpc-server', config: { maxTokensAsSuccess: false } },
    ], null, 2), { mode: 0o600 })
    runtime = dshCreateRuntime({
      dshBin: input.dshBin ?? path.join(projectRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      dshHome,
      cwd: path.resolve(input.cwd ?? projectRoot),
      processCwd: path.resolve(input.processCwd ?? dshHome),
      profile: 'sdk',
      patches: [path.join(projectRoot, 'backend/dsh-business.patch.yml'), ...(input.patches ?? []), patchPath],
      provider: data.configuration.router.provider,
      model: data.configuration.router.model,
      maxTokens: input.maxTokens,
      env: {
        ...input.env,
        CHONGMING_DATA_API: input.dataApiUrl,
        CHONGMING_DATA_TOKEN: input.token,
      },
    })
    await runtime.start()
    for (let round = 0; round < maxRounds; round++) {
      // The role prompt remains supplied by the frozen Run configuration.
      const result = await runtime.run({ sessionId: rootSessionId, prompt: data.configuration.router.content }, input.onEvent)
      data = await dshReadVerification(input)
      if (data.phase === 'waiting' || data.phase === 'done') {
        return { mapId: input.mapId, runId: data.runId, operationId: input.operationId, sessionId: result.sessionId, phase: data.phase, finalResponse: result.finalResponse }
      }
    }
    throw new Error('DSH stopped before a business boundary after ' + maxRounds + ' root turns; operation remains resumable')
  } finally {
    try { await runtime?.close() } finally { await rm(patchDir, { recursive: true, force: true }) }
  }
}
