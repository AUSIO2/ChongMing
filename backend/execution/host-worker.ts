// 文件职责：监听工作队列，管理领取、续租、DSH 执行、确认重试与关闭排空。
import { RuntimeMessage, messageFormat } from '../../contracts/messages'
import { activityCreateReporter } from './dsh/activity-reporter'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { GraphWorkCommand, GraphWorkGrant, GraphWorkProof } from '../../contracts/graph'
import type { GraphClaimResult, QueueWork } from '../../contracts/events'
import type { DshEvent } from '../../contracts/dsh'
import { dshRunWork, type DshWorkInput } from './dsh/work-executor'
import { workReadConcurrency, type WorkTransport } from '../ports/messaging'
import type { DiagnosticReporter, DiagnosticSeverity } from '../../contracts/diagnostics'

export interface HostExecutionEvent {
  hostId: string
  executionSlotId: string
  workId: string
  holderId: string
  fence: number
  event: DshEvent
}

export interface HostInput extends Omit<DshWorkInput, 'grant' | 'signal' | 'onEvent'> {
  hostId?: string
  queue: WorkTransport
  concurrency?: number
  requestTimeoutMs?: number
  reporter?: DiagnosticReporter
  // 接收附带 Host、执行槽和租约身份的事件，避免并发 DSH 会话的裸事件相互混淆。
  onEvent?: (/* 一份工作产生的已归属 DSH 事件。 */ event: HostExecutionEvent) => void
}

interface HostMessaging { version: 1; deploymentId: string; namespace: string; enabled: boolean }
class HostApiError extends Error {
  constructor(/* 工作 API 返回的 HTTP 状态码，用于区分鉴权、限流和服务器故障。 */ readonly status: number, /* 远端公共业务错误码，保留为只读诊断字段。 */ readonly code: string, /* 描述本次远端失败的消息文本。 */ message: string) {
    // 保留工作 API 的 HTTP 状态和业务错误码，供调用方区分鉴权失败与可重试错误。
    super(`${code}: ${message}`)
  }
}
class HostProtocolError extends Error {
  constructor(/* 解释配置或授权响应违反 Host 协议的原因。 */ message: string) {
    // 标记队列配置或授权响应违背协议的错误，让 Host 终止消费而非持续重试。
    super(message); this.name = 'HostProtocolError'
  }
}

export interface HostWorker {
  readonly hostId: string
  readonly concurrency: number
  // 校验部署并启动消费；重复调用共用同一次启动，启动失败由此 Promise 拒绝，关闭后禁止重启。
  start(): Promise<void>
  // 在 start 后等待消费循环结束并返回记录的致命错误；启动错误仍由 start 的调用方处理。
  finished(): Promise<unknown | undefined>
  // 中止执行并等待启动、消费及工作清理结束；重复调用共用同一个关闭 Promise。
  close(): Promise<void>
}

function hostReadDuration(/* 待校验的时间间隔，单位毫秒，必须是正安全整数且不超过计时器上限。 */ value: number, /* 对应配置或协议字段名，用于报错时定位非法时长。 */ name: string): number {
  // 拒绝非正整数或超过计时器上限的配置值，并返回通过校验的原值。
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_INTEGER_FROM_1_TO_2147483647, name))
  }
  return value
}

async function hostWaitInterval(/* 本次续租或重试前等待的毫秒数。 */ ms: number, /* Host 或投递的取消信号，中止时结束本次等待。 */ signal: AbortSignal): Promise<void> {
  // 等待重试或续租间隔；取消只结束等待，其他计时错误继续抛出。
  try { await delay(ms, undefined, { signal }) }
  catch (error) { if (!signal.aborted) throw error }
}

export function hostCreateWorker(/* 部署入口提供的 Host 身份、API、队列与 DSH 配置，创建时验证必要字段。 */ input: HostInput, /* 执行单份已领取工作的函数，默认使用真实 DSH 执行器；须响应取消并完成清理。 */ runner: typeof dshRunWork = dshRunWork): HostWorker {
  // 校验 Host 配置并创建工作消费者，由 Host 管理领取、续租和释放，由 runner 执行授权内的工作。
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
  const concurrency = workReadConcurrency({ concurrency: input.concurrency })
  // 这些状态仅属于当前 Host；start/close 共用各自的 Promise，关闭后不再开启新的消费循环。
  const stop = new AbortController()
  const availableSlots = Array.from({ length: concurrency }, (/* 当前执行槽的零基位置，用于建立稳定槽位身份。 */ _value, /* 槽位在本 Host 内的零基序号。 */ index) => /* 生成只在本 Host 内使用的执行槽编号。 */ `slot-${index + 1}`)
  const activeWorks = new Map<string, Promise<'ack' | 'retry'>>()
  let starting: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let loop: Promise<void> | undefined
  let failure: unknown | undefined

  function hostReport(/* 结构化诊断事件名，标识 Host 生命周期或工作失败阶段。 */ name: string, /* 事件严重程度，决定未配置报告器时是否输出控制台错误。 */ severity: DiagnosticSeverity, /* 可选原始异常，供内部诊断保留失败原因。 */ error?: unknown, /* 可选有界诊断字段，默认空对象，通常包含工作和 Operation 身份。 */ context: Record<string, string | number | boolean> = {}) {
    // 向注入的诊断器上报 Host 事件；未配置诊断器时只将错误和致命事件写入控制台。
    if (input.reporter) input.reporter.report({ name, severity, error, context })
    else if (severity === 'error' || severity === 'fatal') console.error(`[host:${hostId}] ${name}`)
  }

  async function hostCallApi<T>(/* 待提交的工作命令；undefined 表示改为读取消息配置。 */ command: GraphWorkCommand | undefined, /* 可选生命周期信号，与每次请求的独立超时共同限制 API 调用。 */ signal?: AbortSignal): Promise<T> {
    // 携带 Host 凭据读取队列配置或提交工作命令，并为每次请求设置独立超时。
    const timeout = new AbortController()
    const timer = setTimeout(() =>
      /* 请求超过时限时中止 fetch，避免启动、续租或释放无限等待。 */
      timeout.abort(new Error(RuntimeMessage.WORK_API_REQUEST_TIMED_OUT)), requestTimeoutMs)
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

  function hostReadGrant(/* API 返回的授权对象，仍需核对 Host、工作身份与租约参数。 */ grant: GraphWorkGrant, /* 本次领取请求随机生成的持有者身份，响应必须原样匹配。 */ holderId: string): GraphWorkGrant {
    // 核对授权归属、本次领取身份、阶段规格及租约参数，并冻结副本防止执行期间被改写。
    if (!grant || grant.hostId !== hostId || grant.holderId !== holderId
      || !grant.workId || !grant.mapId || !grant.runId || !grant.operationId
      || !grant.stageId || !grant.slotId || !grant.specHash
      || !Number.isSafeInteger(grant.fence) || grant.fence < 1) {
      throw new HostProtocolError(RuntimeMessage.WORK_API_RETURNED_ANOTHER_OR_INVALID_EXECUTION_GRANT)
    }
    hostReadDuration(grant.leaseMs, 'grant.leaseMs')
    return Object.freeze({ ...grant })
  }

  async function hostRunWork(/* 已验证并冻结的本次执行授权，整个 DSH 工作期间不得替换。 */ grant: GraphWorkGrant, /* 当前工作独占的 Host 执行槽身份，直到清理和释放后才归还。 */ executionSlotId: string, /* 领取请求开始时的 performance.now 毫秒值，用于保守计算本地截止时间。 */ acquiredAt: number, /* 队列投递取消信号，断线时必须终止当前执行。 */ deliverySignal: AbortSignal): Promise<'ack' | 'retry'> {
    // 执行已领取的工作并维护租约；执行完成或失败上报成功时确认消息，其他中断请求重投。
    const proof: GraphWorkProof & { mapId: string } = {
      mapId: grant.mapId, workId: grant.workId, holderId: grant.holderId, fence: grant.fence,
    }
    const execution = new AbortController()
    const renewal = new AbortController()
    const signal = AbortSignal.any([stop.signal, execution.signal, deliverySignal])
    const renewalSignal = AbortSignal.any([signal, renewal.signal])
    const activity = activityCreateReporter({ dataApiUrl: input.dataApiUrl, token, grant, signal })
    let deadline: ReturnType<typeof setTimeout> | undefined

    function hostUpdateDeadline(/* 本次领取或续租发起时的单调时钟毫秒值，而非响应到达时间。 */ requestStartedAt: number): void {
      // 按本次领取或续租请求的起点重设本地截止时间，到期即取消执行。
      clearTimeout(deadline)
      // 请求早于服务端授予租约，按单调时钟从请求发出时计时会保守地提前到期，也不依赖两端墙上时钟一致。
      const remaining = requestStartedAt + grant.leaseMs - performance.now()
      if (remaining <= 0) execution.abort(new Error(RuntimeMessage.EXECUTION_LEASE_ELAPSED_BEFORE_CONFIRMATION))
      else deadline = setTimeout(() =>
        /* 本地期限耗尽后立即取消执行，不等待下一次续租响应。 */
        execution.abort(new Error(RuntimeMessage.EXECUTION_LEASE_EXPIRED)), remaining)
    }

    hostUpdateDeadline(acquiredAt)
    const renewals = (async () => {
      // 在工作执行期间定期续租；任何未被主动取消的续租错误都会终止本次执行。
      try {
        while (!renewalSignal.aborted) {
          await hostWaitInterval(Math.max(1, Math.floor(grant.leaseMs / 3)), renewalSignal)
          if (renewalSignal.aborted) return
          const requestStartedAt = performance.now()
          const renewed = await hostCallApi<GraphWorkGrant>({ method: 'renew', params: proof }, renewalSignal)
          hostReadGrant(renewed, grant.holderId)
          // 续租只能延长有效期，不能替换工作、阶段、槽位、冻结规格或隔离旧持有者的 fence。
          if (renewed.workId !== grant.workId || renewed.mapId !== grant.mapId || renewed.runId !== grant.runId
            || renewed.operationId !== grant.operationId || renewed.fence !== grant.fence
            || renewed.stageId !== grant.stageId || renewed.slotId !== grant.slotId || renewed.specHash !== grant.specHash
            || renewed.leaseMs !== grant.leaseMs) {
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
        patches: input.patches, env: { ...input.env, CHONGMING_HOST_ID: hostId, CHONGMING_EXECUTION_SLOT_ID: executionSlotId }, maxTokens: input.maxTokens,
        maxRounds: input.maxRounds, onEvent: /* 执行器发出的公共 DSH 通知，转成活动摘要并交给调用者观察。 */ event => {
          // 将执行事件交给活动摘要，并附上工作、槽位和租约身份后通知 Host 观察者。
          activity.event(event); input.onEvent?.({ hostId, executionSlotId, workId: grant.workId,
            holderId: grant.holderId, fence: grant.fence, event })
        },
      })
      return 'ack'
    } catch (error) {
      // 数据访问可能先于续租发现不可用或租约丢失；此时应重投工作，不能把 Run 永久标记为执行失败。
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
      // runner 已完成运行时清理，才可交还租约。释放不继承已取消的 Host 信号，但仍受单次请求超时约束。
      try { await hostCallApi({ method: 'release', params: proof }) }
      catch (error) { hostReport('host.work.release.failed', 'warn', error, { workId: grant.workId }) }
    }
  }

  async function hostReadQueue() {
    // 核对 API 的部署身份与队列命名空间后打开连接；若打开期间已关闭 Host，则立即释放连接。
    const info = await hostCallApi<HostMessaging>(undefined, stop.signal)
    if (!info || info.version !== 1 || info.enabled !== true || !info.deploymentId
      || info.namespace !== `${input.queue.namespace}.${info.deploymentId}`) {
      throw new HostProtocolError(RuntimeMessage.HOST_QUEUE_CONFIGURATION_DOES_NOT_MATCH_THE_ENABLED_API_DEPLOYMENT)
    }
    const link = await input.queue.open(info.namespace)
    if (stop.signal.aborted) { await link.close(); throw stop.signal.reason }
    return { info, link }
  }

  async function hostRunNotice(/* 队列提供的工作线索，仍需检查部署身份并向 API 领取授权。 */ notice: QueueWork, /* 此次投递的取消信号，由队列连接或消费者停止触发。 */ deliverySignal: AbortSignal, /* 已由消息配置确认的部署身份，通知必须属于同一部署。 */ deploymentId: string): Promise<'ack' | 'retry'> {
    // 合并本 Host 内同一工作提示，为新工作分配空闲槽并在完整清理后归还。
    const signal = AbortSignal.any([stop.signal, deliverySignal])
    if (notice.deploymentId !== deploymentId) {
      stop.abort(new Error(RuntimeMessage.QUEUE_WORK_BELONGS_TO_ANOTHER_DEPLOYMENT))
      return 'retry'
    }
    const workKey = notice.mapId + ':' + notice.workId
    if (activeWorks.has(workKey)) return 'ack'
    const executionSlotId = availableSlots.shift()
    if (!executionSlotId) throw new HostProtocolError(RuntimeMessage.HOST_EXECUTION_CAPACITY_WAS_EXCEEDED)
    const task = (async () => {
      // 使用本次槽位的独立 holder 领取并运行工作；错误只取消所属执行，永久协议错误才停止 Host。
      try {
        signal.throwIfAborted()
        const holderId = randomUUID(), acquiredAt = performance.now()
        const result = await hostCallApi<GraphClaimResult>({ method: 'claim', params: {
          hostId, holderId, mapId: notice.mapId, workId: notice.workId, deploymentId,
        } }, signal)
        if (result.status === 'obsolete') return 'ack'
        if (result.status === 'busy') {
          // 保留当前投递直到服务端给出的等待期结束，避免其他 Host 持租时反复争抢同一工作。
          await hostWaitInterval(hostReadDuration(result.retryAfterMs, 'claim.retryAfterMs'), signal)
          return 'retry'
        }
        if (result.status !== 'claimed') throw new HostProtocolError(RuntimeMessage.WORK_API_RETURNED_AN_INVALID_CLAIM_RESULT)
        const grant = hostReadGrant(result.grant, holderId)
        if (grant.mapId !== notice.mapId || grant.workId !== notice.workId) throw new HostProtocolError(RuntimeMessage.WORK_API_RETURNED_ANOTHER_QUEUED_WORK)
        const outcome = await hostRunWork(grant, executionSlotId, acquiredAt, signal)
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
    })()
    activeWorks.set(workKey, task)
    try { return await task }
    finally {
      activeWorks.delete(workKey)
      availableSlots.push(executionSlotId)
    }
  }

  async function hostRunQueue(/* 启动时已校验的消息配置与队列连接，由消费循环接管其关闭和恢复。 */ initial: Awaited<ReturnType<typeof hostReadQueue>>): Promise<void> {
    // 持续消费队列，断线后关闭旧连接并退避重连；配置、协议或处理器错误终止整个 Host。
    let current = initial
    let reconnectMs = 250
    while (!stop.signal.aborted) {
      try {
        // 队列适配器按 Host 容量投递，并在消费结束前等待全部处理器清理，防止重连后执行重叠。
        await current.link.consumeWork((/* 本连接投递的合法工作通知，交给领取及执行流程。 */ notice, /* 当前投递关联的取消信号，失联时传给执行器。 */ signal) =>
          /* 使用当前连接对应的部署身份校验通知，并返回确认或重投决定。 */
          hostRunNotice(notice, signal, current.info.deploymentId), stop.signal, { concurrency })
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
    hostId, concurrency,
    start() {
      // 仅在首次调用时建立队列连接并启动后台消费，后续调用复用启动结果。
      if (closing) return Promise.reject(new Error(RuntimeMessage.HOST_IS_CLOSED))
      return starting ??= hostReadQueue().then(/* 首次读取并校验成功的队列连接与部署消息配置。 */ initial => {
        // 初始连接成功后接管消费循环，并保存可供 finished/close 等待的 Promise。
        loop = hostRunQueue(initial).catch(/* 消费循环未处理的异常，保存为 Host 永久终止原因。 */ error => {
          // 记录消费循环逸出的致命错误并触发 Host 取消，使 finished 能返回失败原因。
          hostReport('host.loop.failed', 'fatal', error)
          failure = error
          stop.abort(error)
        })
      })
    },
    async finished() {
      // 等待已发起的启动与消费结束，返回循环记录的失败；此方法本身不会启动 Host。
      await starting?.catch(() => {
        // 启动失败由 start 的调用方处理，不让它阻止等待消费循环收尾。
      }); await loop; return failure
    },
    close() {
      // 共用一次关闭操作，取消活动工作并等待消费循环连同工作清理全部结束。
      return closing ??= (async () => {
        // 先广播停止，再等待可能仍在建立的连接和已运行的消费循环退出。
        stop.abort(new Error(RuntimeMessage.HOST_IS_STOPPING))
        await starting?.catch(() => {
          // 启动失败也必须继续完成关闭；原始启动错误仍保留在 start 返回的 Promise 中。
        })
        await loop
      })()
    },
  }
}
