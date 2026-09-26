import { RuntimeMessage, messageFormat } from '../../contracts/messages'
import { activityCreateReporter } from './dsh/activity-reporter'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { GraphWorkCommand, GraphWorkGrant, GraphWorkProof } from '../../contracts/graph'
import type { GraphClaimResult, QueueWork } from '../../contracts/events'
import { dshRunWork, type DshWorkInput } from './dsh/work-executor'
import type { WorkTransport } from '../ports/messaging'
import type { DiagnosticReporter, DiagnosticSeverity } from '../../contracts/diagnostics'

export interface HostInput extends Omit<DshWorkInput, 'grant' | 'signal'> {
  hostId?: string
  queue: WorkTransport
  requestTimeoutMs?: number
  reporter?: DiagnosticReporter
}

interface HostMessaging { version: 1; deploymentId: string; namespace: string; enabled: boolean }
class HostApiError extends Error {
  // 用途：初始化HostApiError实例。
  constructor(readonly status: number, readonly code: string, message: string) { super(`${code}: ${message}`) }
}
class HostProtocolError extends Error { // 用途：初始化HostProtocolError实例。
  // 用途：初始化HostProtocolError实例。
  constructor(message: string) { super(message); this.name = 'HostProtocolError' } }

export interface HostWorker {
  readonly hostId: string
  start(): Promise<void>
  finished(): Promise<unknown | undefined>
  close(): Promise<void>
}

// 用途：读取时长，并把结构化结果交给调用方。
function hostReadDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_INTEGER_FROM_1_TO_2147483647, name))
  }
  return value
}

// 用途：处理Host 工作相关工作，并把结果交给调用方。
async function hostWaitInterval(ms: number, signal: AbortSignal): Promise<void> {
  try { await delay(ms, undefined, { signal }) }
  catch (error) { if (!signal.aborted) throw error }
}

/** One Host owns at most one role work item; DSH owns execution inside that item. */
// 用途：创建Host 工作，供后续流程使用。
export function hostCreateWorker(input: HostInput, runner: typeof dshRunWork = dshRunWork): HostWorker {
  const hostId = input.hostId?.trim() || randomUUID()
  const token = input.token.trim()
  if (!token) throw new Error(RuntimeMessage.CHONGMING_DATA_TOKEN_MUST_BE_CONFIGURED)
  if (!input.dshHome.trim()) throw new Error(RuntimeMessage.DSHHOME_MUST_NOT_BE_EMPTY)
  if (input.maxRounds !== undefined && (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 10)) {
    throw new Error(RuntimeMessage.MAXROUNDS_MUST_BE_AN_INTEGER_FROM_1_TO_10)
  }
  if (input.maxTokens !== undefined) hostReadDuration(input.maxTokens, 'maxTokens')
  if (!['http:', 'https:'].includes(new URL(input.dataApiUrl).protocol)) throw new Error(RuntimeMessage.DATA_API_MUST_USE_HTTP_S)
  const requestTimeoutMs = hostReadDuration(input.requestTimeoutMs ?? 5000, 'requestTimeoutMs')
  const stop = new AbortController()
  let starting: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let loop: Promise<void> | undefined
  let failure: unknown | undefined

  // 用途：处理Host 工作相关工作，并把结果交给调用方。
  function hostReport(name: string, severity: DiagnosticSeverity, error?: unknown, context: Record<string, string | number | boolean> = {}) {
    if (input.reporter) input.reporter.report({ name, severity, error, context })
    else if (severity === 'error' || severity === 'fatal') console.error(`[host:${hostId}] ${name}`)
  }

  // 用途：处理Host 工作相关工作，并把结果交给调用方。
  async function hostCallApi<T>(command: GraphWorkCommand | undefined, signal?: AbortSignal): Promise<T> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error(RuntimeMessage.WORK_API_REQUEST_TIMED_OUT)), requestTimeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    try {
      const response = await fetch(new URL(command ? '/internal/v1/work' : '/internal/v1/messaging', input.dataApiUrl), {
        method: command ? 'POST' : 'GET', signal: requestSignal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        ...(command ? { body: JSON.stringify(command) } : {}),
      })
      const body = await response.json() as { ok: boolean; data?: T; error?: { code?: string; message?: string } }
      if (!response.ok || body.ok !== true) {
        throw new HostApiError(response.status, body.error?.code ?? String(response.status), body.error?.message ?? RuntimeMessage.WORK_API_REQUEST_FAILED)
      }
      return body.data as T
    } finally { clearTimeout(timer) }
  }

  // 用途：读取授权，并把结构化结果交给调用方。
  function hostReadGrant(grant: GraphWorkGrant, holderId: string): GraphWorkGrant {
    if (!grant || grant.hostId !== hostId || grant.holderId !== holderId
      || !grant.workId || !grant.mapId || !grant.runId || !grant.operationId
      || !Number.isSafeInteger(grant.fence) || grant.fence < 1) {
      throw new HostProtocolError(RuntimeMessage.WORK_API_RETURNED_ANOTHER_OR_INVALID_EXECUTION_GRANT)
    }
    hostReadDuration(grant.leaseMs, 'grant.leaseMs')
    return Object.freeze({ ...grant, actor: Object.freeze({ ...grant.actor }) })
  }

  // 用途：执行工作流程，并返回执行结果。
  async function hostRunWork(grant: GraphWorkGrant, acquiredAt: number, deliverySignal: AbortSignal): Promise<'ack' | 'retry'> {
    const proof: GraphWorkProof & { mapId: string } = {
      mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence,
    }
    const execution = new AbortController()
    const renewal = new AbortController()
    const signal = AbortSignal.any([stop.signal, execution.signal, deliverySignal])
    const renewalSignal = AbortSignal.any([signal, renewal.signal])
    const activity = activityCreateReporter({ dataApiUrl: input.dataApiUrl, token, grant, signal })
    let deadline: ReturnType<typeof setTimeout> | undefined

    // 用途：更新Host 工作，并保持相关状态一致。
    function hostUpdateDeadline(requestStartedAt: number): void {
      clearTimeout(deadline)
      // A request starts before Mongo grants its lease: this monotonic deadline is conservative.
      const remaining = requestStartedAt + grant.leaseMs - performance.now()
      if (remaining <= 0) execution.abort(new Error(RuntimeMessage.EXECUTION_LEASE_ELAPSED_BEFORE_CONFIRMATION))
      else deadline = setTimeout(() => execution.abort(new Error(RuntimeMessage.EXECUTION_LEASE_EXPIRED)), remaining)
    }

    hostUpdateDeadline(acquiredAt)
    const renewals = (async () => {
      try {
        while (!renewalSignal.aborted) {
          await hostWaitInterval(Math.max(1, Math.floor(grant.leaseMs / 3)), renewalSignal)
          if (renewalSignal.aborted) return
          const requestStartedAt = performance.now()
          const renewed = await hostCallApi<GraphWorkGrant>({ method: 'renew', params: proof }, renewalSignal)
          hostReadGrant(renewed, grant.holderId)
          if (renewed.workId !== grant.workId || renewed.mapId !== grant.mapId || renewed.runId !== grant.runId
            || renewed.operationId !== grant.operationId || renewed.fence !== grant.fence
            || renewed.routeRevision !== grant.routeRevision || renewed.leaseMs !== grant.leaseMs
            || JSON.stringify(renewed.actor) !== JSON.stringify(grant.actor)) {
            throw new HostProtocolError(RuntimeMessage.RENEWAL_CHANGED_THE_EXECUTION_GRANT)
          }
          hostUpdateDeadline(requestStartedAt)
          activity.update()
        }
      } catch (error) {
        if (!renewalSignal.aborted) {
          hostReport('host.lease.renew.failed', 'error', error, { workId: grant.workId })
          execution.abort(error)
          if (error instanceof HostProtocolError) { failure = error; stop.abort(error) }
        }
      }
    })()

    try {
      signal.throwIfAborted()
      activity.update()
      await runner({
        grant, dataApiUrl: input.dataApiUrl, token, dshHome: input.dshHome, signal,
        dshBin: input.dshBin, cwd: input.cwd, processCwd: input.processCwd,
        patches: input.patches, env: { ...input.env, CHONGMING_HOST_ID: hostId }, maxTokens: input.maxTokens,
        maxRounds: input.maxRounds, onEvent: event => { activity.event(event); input.onEvent?.(event) },
      })
      return 'ack'
    } catch (error) {
      // Data access can fail before the next heartbeat; it must not become a permanent Run failure.
      if (error instanceof Error && (error.name === 'WorkAccessError' || error.message.includes('LEASE_LOST'))) execution.abort(error)
      if (!signal.aborted) {
        hostReport('host.work.failed', 'error', error, { workId: grant.workId, operationId: grant.operationId })
        try {
          await hostCallApi({ method: 'fail', params: { ...proof, message: RuntimeMessage.DSH_EXECUTION_FAILED_ON_THE_HOST } }, signal)
          return 'ack'
        } catch (failure) {
          if (!signal.aborted) hostReport('host.work.failure-record.failed', 'error', failure, { workId: grant.workId })
        }
      }
      return 'retry'
    } finally {
      await activity.close()
      renewal.abort()
      clearTimeout(deadline)
      await renewals
      // The runner has drained its runtime. Release still gets a bounded request during Host shutdown.
      try { await hostCallApi({ method: 'release', params: proof }) }
      catch (error) { hostReport('host.work.release.failed', 'warn', error, { workId: grant.workId }) }
    }
  }

  // 用途：读取Host 工作，并把结构化结果交给调用方。
  async function hostReadQueue() {
    const info = await hostCallApi<HostMessaging>(undefined, stop.signal)
    if (!info || info.version !== 1 || info.enabled !== true || !info.deploymentId
      || info.namespace !== `${input.queue.namespace}.${info.deploymentId}`) {
      throw new HostProtocolError(RuntimeMessage.HOST_QUEUE_CONFIGURATION_DOES_NOT_MATCH_THE_ENABLED_API_DEPLOYMENT)
    }
    const link = await input.queue.open(info.namespace)
    if (stop.signal.aborted) { await link.close(); throw stop.signal.reason }
    return { info, link }
  }

  // 用途：执行Host 工作流程，并返回执行结果。
  async function hostRunNotice(notice: QueueWork, deliverySignal: AbortSignal, deploymentId: string): Promise<'ack' | 'retry'> {
    const signal = AbortSignal.any([stop.signal, deliverySignal])
    if (notice.deploymentId !== deploymentId) {
      stop.abort(new Error(RuntimeMessage.QUEUE_WORK_BELONGS_TO_ANOTHER_DEPLOYMENT))
      return 'retry'
    }
    try {
      signal.throwIfAborted()
      const holderId = randomUUID(), acquiredAt = performance.now()
      const result = await hostCallApi<GraphClaimResult>({ method: 'claim', params: {
        hostId, holderId, mapId: notice.mapId, workId: notice.workId, deploymentId,
      } }, signal)
      if (result.status === 'obsolete') return 'ack'
      if (result.status === 'busy') {
        await hostWaitInterval(hostReadDuration(result.retryAfterMs, 'claim.retryAfterMs'), signal)
        return 'retry'
      }
      if (result.status !== 'claimed') throw new HostProtocolError(RuntimeMessage.WORK_API_RETURNED_AN_INVALID_CLAIM_RESULT)
      const grant = hostReadGrant(result.grant, holderId)
      if (grant.mapId !== notice.mapId || grant.workId !== notice.workId) throw new HostProtocolError(RuntimeMessage.WORK_API_RETURNED_ANOTHER_QUEUED_WORK)
      const outcome = await hostRunWork(grant, acquiredAt, signal)
      if (outcome === 'retry') await hostWaitInterval(1000, signal)
      return outcome
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof HostProtocolError || (error instanceof HostApiError && [401, 403].includes(error.status))) {
          failure = error; stop.abort(error)
        }
        else {
          hostReport('host.work.retry', 'warn', error, { workId: notice.workId })
          await hostWaitInterval(1000, signal)
        }
      }
      return 'retry'
    }
  }

  // 用途：执行Host 工作流程，并返回执行结果。
  async function hostRunQueue(initial: Awaited<ReturnType<typeof hostReadQueue>>): Promise<void> {
    let current = initial
    let reconnectMs = 250
    while (!stop.signal.aborted) {
      try {
        await current.link.consumeWork((notice, signal) => hostRunNotice(notice, signal, current.info.deploymentId), stop.signal)
      } catch (error) {
        const cause = current.link.signal.reason ?? error
        if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'QUEUE_HANDLER') {
          failure = cause; stop.abort(cause); hostReport('host.queue.handler.failed', 'fatal', cause); return
        }
        if (!stop.signal.aborted) hostReport('host.queue.disconnected', 'warn', error)
      } finally {
        await current.link.close()
      }
      while (!stop.signal.aborted) {
        await hostWaitInterval(reconnectMs, stop.signal)
        if (stop.signal.aborted) return
        try { current = await hostReadQueue(); reconnectMs = 250; break }
        catch (error) {
          if (error instanceof HostProtocolError || (error && typeof error === 'object' && 'code' in error
            && ['QUEUE_CONFIG', 'QUEUE_SETUP', 'QUEUE_HANDLER'].includes(String(error.code)))) {
            failure = error; stop.abort(error); hostReport('host.queue.protocol.failed', 'fatal', error); return
          }
          if (!stop.signal.aborted) hostReport('host.queue.reconnect', 'warn', error)
          reconnectMs = Math.min(reconnectMs * 2, 5000)
        }
      }
    }
  }

  return {
    hostId,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    start() {
      if (closing) return Promise.reject(new Error(RuntimeMessage.HOST_IS_CLOSED))
      return starting ??= hostReadQueue().then(initial => {
        loop = hostRunQueue(initial).catch(error => {
          hostReport('host.loop.failed', 'fatal', error)
          failure = error
          stop.abort(error)
        })
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async finished() { await starting?.catch(() => {}); await loop; return failure },
    // 用途：关闭当前模块并释放占用的资源。
    close() {
      return closing ??= (async () => {
        stop.abort(new Error(RuntimeMessage.HOST_IS_STOPPING))
        await starting?.catch(() => {})
        await loop
      })()
    },
  }
}
