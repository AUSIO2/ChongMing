import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { GraphWorkCommand, GraphWorkGrant, GraphWorkProof } from '../contracts/graph'
import { dshRunWork, type DshWorkInput } from './dsh-verify'

export interface HostInput extends Omit<DshWorkInput, 'grant' | 'signal'> {
  hostId?: string
  mapId?: string
  pollMs?: number
  requestTimeoutMs?: number
}

export interface HostWorker {
  readonly hostId: string
  start(): Promise<void>
  close(): Promise<void>
}

function hostReadDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`${name} must be an integer from 1 to 2147483647`)
  }
  return value
}

async function hostWaitInterval(ms: number, signal: AbortSignal): Promise<void> {
  try { await delay(ms, undefined, { signal }) }
  catch (error) { if (!signal.aborted) throw error }
}

/** One Host owns at most one role work item; DSH owns execution inside that item. */
export function hostCreateWorker(input: HostInput, runner: typeof dshRunWork = dshRunWork): HostWorker {
  const hostId = input.hostId?.trim() || randomUUID()
  const token = input.token.trim()
  if (!token) throw new Error('CHONGMING_DATA_TOKEN must be configured')
  if (!input.dshHome.trim()) throw new Error('dshHome must not be empty')
  if (input.mapId !== undefined && !input.mapId.trim()) throw new Error('mapId must not be empty')
  if (input.maxRounds !== undefined && (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 10)) {
    throw new Error('maxRounds must be an integer from 1 to 10')
  }
  if (input.maxTokens !== undefined) hostReadDuration(input.maxTokens, 'maxTokens')
  const url = new URL('/internal/v1/work', input.dataApiUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Data API must use HTTP(S)')
  const pollMs = hostReadDuration(input.pollMs ?? 1000, 'pollMs')
  const requestTimeoutMs = hostReadDuration(input.requestTimeoutMs ?? 5000, 'requestTimeoutMs')
  const stop = new AbortController()
  let starting: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let loop: Promise<void> | undefined

  async function hostCallWork<T>(command: GraphWorkCommand, signal?: AbortSignal): Promise<T> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('Work API request timed out')), requestTimeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    try {
      const response = await fetch(url, {
        method: 'POST', signal: requestSignal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(command),
      })
      const body = await response.json() as { ok: boolean; data?: T; error?: { code?: string; message?: string } }
      if (!response.ok || body.ok !== true) {
        throw new Error(`${body.error?.code ?? response.status}: ${body.error?.message ?? 'Work API request failed'}`)
      }
      return body.data as T
    } finally { clearTimeout(timer) }
  }

  function hostReadGrant(grant: GraphWorkGrant, holderId: string): GraphWorkGrant {
    if (!grant || grant.hostId !== hostId || grant.holderId !== holderId
      || !grant.workId || !grant.mapId || !grant.runId || !grant.operationId
      || (input.mapId !== undefined && grant.mapId !== input.mapId)
      || !Number.isSafeInteger(grant.fence) || grant.fence < 1) {
      throw new Error('Work API returned another or invalid execution grant')
    }
    hostReadDuration(grant.leaseMs, 'grant.leaseMs')
    return Object.freeze({ ...grant, actor: Object.freeze({ ...grant.actor }) })
  }

  async function hostRunWork(grant: GraphWorkGrant, acquiredAt: number): Promise<void> {
    const proof: GraphWorkProof & { mapId: string } = {
      mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence,
    }
    const execution = new AbortController()
    const renewal = new AbortController()
    const signal = AbortSignal.any([stop.signal, execution.signal])
    const renewalSignal = AbortSignal.any([signal, renewal.signal])
    let deadline: ReturnType<typeof setTimeout> | undefined

    function hostUpdateDeadline(requestStartedAt: number): void {
      clearTimeout(deadline)
      // A request starts before Mongo grants its lease: this monotonic deadline is conservative.
      const remaining = requestStartedAt + grant.leaseMs - performance.now()
      if (remaining <= 0) execution.abort(new Error('Execution lease elapsed before confirmation'))
      else deadline = setTimeout(() => execution.abort(new Error('Execution lease expired')), remaining)
    }

    hostUpdateDeadline(acquiredAt)
    const renewals = (async () => {
      try {
        while (!renewalSignal.aborted) {
          await hostWaitInterval(Math.max(1, Math.floor(grant.leaseMs / 3)), renewalSignal)
          if (renewalSignal.aborted) return
          const requestStartedAt = performance.now()
          const renewed = await hostCallWork<GraphWorkGrant>({ method: 'renew', params: proof }, renewalSignal)
          hostReadGrant(renewed, grant.holderId)
          if (renewed.workId !== grant.workId || renewed.mapId !== grant.mapId || renewed.runId !== grant.runId
            || renewed.operationId !== grant.operationId || renewed.fence !== grant.fence
            || renewed.routeRevision !== grant.routeRevision || renewed.leaseMs !== grant.leaseMs
            || JSON.stringify(renewed.actor) !== JSON.stringify(grant.actor)) {
            throw new Error('Renewal changed the execution grant')
          }
          hostUpdateDeadline(requestStartedAt)
        }
      } catch (error) {
        if (!renewalSignal.aborted) {
          console.error(`[host:${hostId}] Lease renewal failed for ${grant.workId}`, error)
          execution.abort(error)
        }
      }
    })()

    try {
      signal.throwIfAborted()
      await runner({
        grant, dataApiUrl: input.dataApiUrl, token, dshHome: input.dshHome, signal,
        dshBin: input.dshBin, cwd: input.cwd, processCwd: input.processCwd,
        patches: input.patches, env: { ...input.env, CHONGMING_HOST_ID: hostId }, maxTokens: input.maxTokens,
        maxRounds: input.maxRounds, onEvent: input.onEvent,
      })
    } catch (error) {
      // Data access can fail before the next heartbeat; it must not become a permanent Run failure.
      if (error instanceof Error && (error.name === 'WorkAccessError' || error.message.includes('LEASE_LOST'))) execution.abort(error)
      if (!signal.aborted) {
        console.error(`[host:${hostId}] DSH work failed for ${grant.workId}`, error)
        try {
          await hostCallWork({ method: 'fail', params: { ...proof, message: 'DSH execution failed on the Host' } }, signal)
        } catch (failure) {
          if (!signal.aborted) console.error(`[host:${hostId}] Could not record work failure`, failure)
        }
      }
    } finally {
      renewal.abort()
      clearTimeout(deadline)
      await renewals
      // The runner has drained its runtime. Release still gets a bounded request during Host shutdown.
      try { await hostCallWork({ method: 'release', params: proof }) }
      catch (error) { console.error(`[host:${hostId}] Work release was not confirmed`, error) }
    }
  }

  async function hostRunLoop(): Promise<void> {
    while (!stop.signal.aborted) {
      try {
        const holderId = randomUUID()
        const acquiredAt = performance.now()
        const grant = await hostCallWork<GraphWorkGrant | null>({
          method: 'claim', params: { hostId, holderId, ...(input.mapId ? { mapId: input.mapId } : {}) },
        }, stop.signal)
        if (grant) {
          await hostRunWork(hostReadGrant(grant, holderId), acquiredAt)
          continue
        }
      } catch (error) {
        if (!stop.signal.aborted) console.error(`[host:${hostId}] Work polling failed`, error)
      }
      if (!stop.signal.aborted) await hostWaitInterval(pollMs, stop.signal)
    }
  }

  return {
    hostId,
    start() {
      if (closing) return Promise.reject(new Error('Host is closed'))
      return starting ??= Promise.resolve().then(() => {
        loop = hostRunLoop().catch(error => {
          console.error(`[host:${hostId}] Host loop stopped`, error)
          stop.abort(error)
        })
      })
    },
    close() {
      return closing ??= (async () => {
        stop.abort(new Error('Host is stopping'))
        await starting
        await loop
      })()
    },
  }
}
