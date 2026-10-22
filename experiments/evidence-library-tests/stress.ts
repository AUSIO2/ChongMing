// 只提供待执行的负载与验收驱动，不实现证据库业务或生成本轮压测成绩。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { collectInput, libraryRef, PRESSURE_QUERY } from './fixtures'
import { createTestEnvironment, testBackend, type TestEnvironment } from './load-target'
import { OPERATION_MIX, type Operation, type StressScenario } from './scenarios'
import { HarnessMessage, type ClaimRef, type EvidenceTestTarget, type SeedResult, type Telemetry } from './test-contract'

interface Job { operation: Operation; source: ClaimRef | null; index: number }
interface Bucket { attempted: number; succeeded: number; failed: number; timeouts: number; latenciesMs: number[]; errors: Record<string, number> }
interface Context { pending: Set<Promise<unknown>>; calls: number; peakDriverRssBytes: number; queryIds: Set<string> }
interface RoundResult {
  durationMs: number
  operationsPerSecond: number
  succeeded: number
  notStarted: number
  unfinishedCalls: number
  operations: Record<Operation, Bucket>
}

function failure(
  /* 用于统计失败类别的稳定名称。 */ code: string,
  /* 统一定义的驱动错误文案。 */ message: HarnessMessage,
): Error & { code: string } {
  // 区分请求超时、总期限与业务失败，不通过错误文本猜测类型。
  return Object.assign(new Error(message), { code })
}

function errorCode(
  /* 真实目标或驱动抛出的未知错误。 */ error: unknown,
): string {
  // 只读取明确的错误代码；缺失时保留错误种类，不能当作成功拒绝。
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR'
}

async function bounded<T>(
  /* 追踪未完成真实调用的场景上下文。 */ context: Context,
  /* 向真实目标传递取消信号的操作。 */ action: (signal: AbortSignal) => Promise<T>,
  /* 本次调用最多允许等待的毫秒数。 */ timeoutMs: number,
  /* 所属测量轮的可选总期限信号。 */ parent?: AbortSignal,
): Promise<T> {
  // 超时不等于真实工作已经结束；原 Promise 保留在 pending 中直至实际结算。
  parent?.throwIfAborted()
  const own = new AbortController()
  const signal = parent ? AbortSignal.any([parent, own.signal]) : own.signal
  const timer = setTimeout(() => {
    // 通知真实目标取消，并让当前调用明确失败。
    own.abort(failure('TIMEOUT', HarnessMessage.TIMEOUT))
  }, timeoutMs)
  const original = Promise.resolve().then(() => {
    // 在注册错误处理后调用真实目标，同步抛错也进入失败统计。
    signal.throwIfAborted()
    return action(signal)
  })
  context.pending.add(original)
  void original.then(
    /* 实际操作已完成的返回值。 */ () => { /* 解除已完成调用的追踪。 */ context.pending.delete(original) },
    /* 实际操作已失败的错误。 */ () => { /* 失败已经由 race 消费，仍解除追踪。 */ context.pending.delete(original) },
  )
  let rejectAbort: (() => void) | undefined
  const aborted = new Promise<never>((
    /* 取消路径永不产生正常结果的 resolve。 */ _resolve,
    /* 当前等待者的取消失败回调。 */ reject,
  ) => {
    // 在请求和总期限任一取消时结束等待，不吞掉其失败原因。
    rejectAbort = () => { /* 转发取消错误。 */ reject(signal.reason) }
    signal.addEventListener('abort', rejectAbort, { once: true })
    if (signal.aborted) rejectAbort()
  })
  try { return await Promise.race([original, aborted]) }
  finally {
    clearTimeout(timer)
    if (rejectAbort) signal.removeEventListener('abort', rejectAbort)
  }
}

function buckets(): Record<Operation, Bucket> {
  // 每轮重新建立计数器；预热数据不会混进正式分位数。
  const make = (): Bucket => { /* 建立单类操作的空计数器。 */ return { attempted: 0, succeeded: 0, failed: 0, timeouts: 0, latenciesMs: [], errors: Object.create(null) } }
  return { search: make(), get: make(), collect: make(), cite: make(), snapshot: make() }
}

function percentile(
  /* 本轮实际测到的成功与失败延迟。 */ values: number[],
  /* 最近秩分位数的比例。 */ fraction: number,
): number | null {
  // 无测量就返回 null；不能以 0 毫秒代替缺失指标。
  if (!values.length) return null
  const sorted = [...values].sort(/* 两个延迟样本。 */ (left, right) => /* 数值升序。 */ left - right)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

async function prepareJobs(
  /* 只负责真实调用追踪的上下文。 */ context: Context,
  /* 实际证据库目标。 */ target: EvidenceTestTarget,
  /* 请求上限与准备期限配置。 */ scenario: StressScenario,
  /* 本批业务操作数量。 */ amount: number,
): Promise<Job[]> {
  // 在正式计时之外创建写入来源与独立消费 Map，避免分支互斥混入普通负载。
  return bounded(context, async (
    /* 整个准备批次的取消信号。 */ signal,
  ) => {
    const result: Job[] = []
    for (let index = 0; index < amount; index += 1) {
      signal.throwIfAborted()
      const operation = OPERATION_MIX[index % OPERATION_MIX.length]
      assert.ok(operation)
      const source = operation === 'collect' || operation === 'cite'
        ? await target.fixtures.createNode(target.workspaceId, 'claim', `测量专用陈述 ${randomUUID()}。`, { signal })
        : null
      result.push({ operation, source, index })
    }
    return result
  }, scenario.setupTimeoutMs)
}

async function executeJob(
  /* 当前在途调用的真实追踪。 */ context: Context,
  /* 实际目标。 */ target: EvidenceTestTarget,
  /* 请求时限及组成配置。 */ scenario: StressScenario,
  /* 来自真实预置数据的条目与预期命中。 */ seeded: SeedResult,
  /* 一个确定的业务操作。 */ job: Job,
  /* 本轮总期限信号。 */ signal: AbortSignal,
): Promise<void> {
  // 操作始终调用目标服务；只检查返回值，不计算收录、摘要或授权的预期实现。
  const pool = scenario.hotSetSize === null ? seeded.entryRefs : seeded.entryRefs.slice(0, scenario.hotSetSize)
  const selected = pool[job.index % pool.length]
  assert.ok(selected)
  const expected = context.queryIds
  if (job.operation === 'search') {
    context.calls += 1
    const page = await bounded(context, /* 真实查询取消信号。 */ callSignal => /* 请求一页索引查询。 */ target.request('viewer', 'search', {
      workspaceId: target.workspaceId, query: scenario.queryMode === 'hit' ? seeded.query : 'zzunmatchedterm', limit: 25,
    }, { signal: callSignal }), scenario.requestTimeoutMs, signal)
    assert.ok(page.items.length <= 25)
    if (scenario.queryMode === 'hit') assert.ok(page.items.length > 0)
    else { assert.equal(page.items.length, 0); assert.equal(page.nextCursor, null) }
    for (const item of page.items) assert.ok(expected.has(item.id) && (item.confidence === 0 || item.confidence === 1))
    assert.equal(new Set(page.items.map(/* 本页真实条目。 */ item => /* 比较身份重复。 */ item.id)).size, page.items.length)
  } else if (job.operation === 'get') {
    context.calls += 1
    const entry = await bounded(context, /* 真实读取取消信号。 */ callSignal => /* 读取实际固定内容。 */ target.request('viewer', 'get', {
      workspaceId: target.workspaceId, entryId: selected.entryId,
    }, { signal: callSignal }), scenario.requestTimeoutMs, signal)
    assert.equal(entry.contentDigest, selected.contentDigest)
    assert.ok(entry.confidence === 0 || entry.confidence === 1)
  } else if (job.operation === 'collect') {
    assert.ok(job.source)
    const source = job.source
    const input = collectInput(target, source, Math.floor(job.index / 20) % 2)
    context.calls += 1
    const result = await bounded(context, /* 真实收录取消信号。 */ callSignal => /* 提交明确的 0/1 输入。 */ target.request('editor', 'collect', input, { signal: callSignal }), scenario.requestTimeoutMs, signal)
    assert.equal(result.entry.confidence, input.confidence)
    assert.equal(result.entry.claim.origin.nodeId, source.nodeId)
    assert.ok(result.entry.contentDigest)
  } else if (job.operation === 'cite') {
    assert.ok(job.source)
    const source = job.source
    context.calls += 1
    const work = await bounded(context, /* 冻结阶段取消信号。 */ callSignal => /* 对实际工作授予固定材料。 */ target.request('editor', 'freeze', {
      workspaceId: target.workspaceId, target: source, refs: [selected], mode: 'live',
    }, { signal: callSignal }), scenario.requestTimeoutMs, signal)
    assert.equal(work.mapId, source.mapId)
    assert.ok(work.scopeNodeIds.includes(source.nodeId))
    assert.deepEqual(work.entries.map(/* 获权的真实条目。 */ libraryRef), [selected])
    context.calls += 1
    const result = await bounded(context, /* 提交阶段取消信号。 */ callSignal => /* 通过真实 Work 接纳记录使用关系。 */ target.request('editor', 'submitUse', {
      workspaceId: target.workspaceId, workId: work.workId, refs: [selected], reason: '压测显式引用固定材料', requestId: randomUUID(),
    }, { signal: callSignal }), scenario.requestTimeoutMs, signal)
    assert.ok(result.usages.some(/* 实际产生的使用关系。 */ usage => /* 至少记录所选条目。 */ usage.entryId === selected.entryId))
  } else {
    context.calls += 1
    const refs = pool.slice(0, 32)
    const result = await bounded(context, /* 快照创建取消信号。 */ callSignal => /* 只创建明确清单的固定快照。 */ target.request('editor', 'snapshotCreate', {
      workspaceId: target.workspaceId, refs, requestId: randomUUID(),
    }, { signal: callSignal }), scenario.requestTimeoutMs, signal)
    assert.ok(result.digest)
    assert.deepEqual([...result.entries].sort(/* 固定引用身份。 */ (left, right) => /* 清单顺序不影响内容一致性。 */ left.entryId.localeCompare(right.entryId)),
      [...refs].sort(/* 输入引用身份。 */ (left, right) => /* 对照同一集合。 */ left.entryId.localeCompare(right.entryId)))
  }
}

async function measureRound(
  /* 当前调用追踪。 */ context: Context,
  /* 真实目标。 */ target: EvidenceTestTarget,
  /* 时间与限流配置。 */ scenario: StressScenario,
  /* 预置语料。 */ seeded: SeedResult,
  /* 在途业务操作上限。 */ concurrency: number,
  /* 正式计时前准备好的请求。 */ jobs: Job[],
): Promise<RoundResult> {
  // 业务并发是真正在途操作；具体数据库是否串行由目标 info.executionModel 报告。
  const abort = new AbortController()
  const timer = setTimeout(() => { /* 总期限结束后停止新请求并通知取消。 */ abort.abort(failure('DEADLINE', HarnessMessage.DEADLINE)) }, scenario.roundTimeoutMs)
  const operations = buckets()
  let nextJob = 0, nextAdmission = performance.now()
  let startWorkers: (() => void) | undefined
  const barrier = new Promise<void>((/* 所有工作者共用的启动回调。 */ resolve) => { /* 保存启动屏障。 */ startWorkers = resolve })
  const start = performance.now()
  const workers = Array.from({ length: concurrency }, async () => {
    // 固定数量的工作者共同消费有限请求清单，统计各操作真实完成结果。
    await barrier
    while (nextJob < jobs.length && !abort.signal.aborted) {
      const job = jobs[nextJob++]
      assert.ok(job)
      const admittedAt = Math.max(performance.now(), nextAdmission)
      nextAdmission = admittedAt + 1000 / scenario.maxOperationsPerSecond
      try { await sleep(Math.max(0, admittedAt - performance.now()), undefined, { signal: abort.signal }) }
      catch { break }
      if (abort.signal.aborted) break
      const bucket = operations[job.operation]
      bucket.attempted += 1
      const dispatched = performance.now()
      try {
        await executeJob(context, target, scenario, seeded, job, abort.signal)
        bucket.succeeded += 1
      } catch (error) {
        bucket.failed += 1
        const code = errorCode(error)
        bucket.errors[code] = (bucket.errors[code] ?? 0) + 1
        if (code === 'TIMEOUT') {
          bucket.timeouts += 1
          abort.abort(failure('CANCELLED', HarnessMessage.PHASE_FAILED))
        }
      } finally {
        bucket.latenciesMs.push(performance.now() - dispatched)
        context.peakDriverRssBytes = Math.max(context.peakDriverRssBytes, process.memoryUsage().rss)
      }
    }
  })
  assert.ok(startWorkers)
  startWorkers()
  try { await Promise.all(workers) }
  finally { clearTimeout(timer) }
  const durationMs = performance.now() - start
  const values = Object.values(operations)
  const succeeded = values.reduce(/* 累计值和真实操作计数。 */ (total, bucket) => /* 只累计成功完成。 */ total + bucket.succeeded, 0)
  const attempted = values.reduce(/* 累计值和真实操作计数。 */ (total, bucket) => /* 记录所有已发起操作。 */ total + bucket.attempted, 0)
  return { durationMs, operationsPerSecond: succeeded * 1000 / Math.max(1, durationMs), succeeded,
    notStarted: jobs.length - attempted, unfinishedCalls: context.pending.size, operations }
}

async function expectedRejection(
  /* 必须由真实实现拒绝的调用。 */ action: () => Promise<unknown>,
  /* 预期真实业务代码。 */ code: string,
  /* 预期协议状态。 */ status: number,
): Promise<void> {
  // 任意抛错不等于正确拒绝，超时或 500 不能代替所需业务错误。
  let rejected = false
  try { await action() }
  catch (error) {
    rejected = true
    assert.ok(error !== null && typeof error === 'object' && 'code' in error && 'status' in error)
    assert.equal(error.code, code)
    assert.equal(error.status, status)
  }
  assert.equal(rejected, true)
}

async function correctnessChecks(
  /* 有界实际调用追踪。 */ context: Context,
  /* 真实目标。 */ target: EvidenceTestTarget,
  /* 已知预置内容，不能由查询结果反推。 */ seeded: SeedResult,
  /* 校验阶段期限配置。 */ scenario: StressScenario,
): Promise<void> {
  // 压测后在停止写入的状态核对结果和历史规则，不能只验吞吐。
  await bounded(context, async (/* 整批正确性校验取消信号。 */ signal) => {
    for (const sample of seeded.sampleEntries) {
      const actual = await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: sample.id }, { signal })
      assert.equal(actual.confidence, sample.confidence)
      assert.equal(actual.contentDigest, sample.contentDigest)
      assert.deepEqual(actual.claim, sample.claim)
      assert.deepEqual(actual.decision, sample.decision)
    }
    const found: string[] = [], cursors = new Set<string>()
    let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
      const page = await target.request('viewer', 'search', { workspaceId: target.workspaceId, query: seeded.query, limit: 100, ...(cursor ? { cursor } : {}) }, { signal })
      assert.ok(page.items.length <= 100)
      found.push(...page.items.map(/* 本页真实结果。 */ item => /* 记录身份进行集合比对。 */ item.id))
      if (page.nextCursor === null) break
      assert.ok(!cursors.has(page.nextCursor))
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
      assert.ok(pageNumber < 999)
    }
    assert.equal(new Set(found).size, found.length)
    assert.deepEqual([...found].sort(), [...seeded.expectedQueryIds].sort())
    const entry = seeded.sampleEntries.find(/* 真实预置样本。 */ item => /* 必须检查确定错误的原文。 */ item.confidence === 0)
    assert.ok(entry)
    await expectedRejection(() => { /* 沿用当前协议对非成员隐藏工作区。 */ return target.request('outsider', 'get', { workspaceId: target.workspaceId, entryId: entry.id }, { signal }) }, 'WORKSPACE_NOT_FOUND', 404)
    const foreign = await target.request('owner', 'search', { workspaceId: target.otherWorkspaceId, query: seeded.query }, { signal })
    assert.equal(foreign.items.length, 0)
    const source = await target.fixtures.createNode(target.workspaceId, 'claim', '幂等校验专用陈述。', { signal })
    const input = collectInput(target, source, 0)
    const first = await target.request('editor', 'collect', input, { signal })
    const replay = await target.request('editor', 'collect', input, { signal })
    assert.equal(replay.replayed, true)
    assert.equal(replay.entry.id, first.entry.id)
    const consumer = await target.fixtures.createNode(target.workspaceId, 'claim', '历史引用校验专用目标。', { signal })
    assert.notEqual(consumer.mapId, entry.claim.origin.mapId)
    const ref = libraryRef(entry)
    const work = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer, refs: [ref], mode: 'live' }, { signal })
    const other = seeded.entryRefs.find(/* 预置的真实固定条目。 */ item => /* 选中未获权的不同条目。 */ item.entryId !== entry.id)
    assert.ok(other)
    await expectedRejection(() => { /* 未获权材料不能混入工作输出。 */ return target.request('editor', 'submitUse', { workspaceId: target.workspaceId, workId: work.workId, refs: [other], reason: '越权测试', requestId: randomUUID() }, { signal }) }, 'EVIDENCE_REFERENCE_UNAUTHORIZED', 403)
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId, refs: [ref], requestId: randomUUID() }, { signal })
    await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id, expectedRevision: entry.revision, reason: '测量后校验撤回', requestId: randomUUID() }, { signal })
    await expectedRejection(() => { /* 撤回不进入新的实时选择。 */ return target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer, refs: [ref], mode: 'live' }, { signal }) }, 'EVIDENCE_INACTIVE', 409)
    const originalWork = await target.request('viewer', 'readFrozen', { workspaceId: target.workspaceId, workId: work.workId }, { signal })
    assert.equal(originalWork.entries[0]?.confidence, 0)
    assert.equal(originalWork.entries[0]?.contentDigest, entry.contentDigest)
    const submitted = { workspaceId: target.workspaceId, workId: work.workId, refs: [ref], reason: '冻结后仍引用原材料', requestId: randomUUID() }
    const usage = await target.request('editor', 'submitUse', submitted, { signal })
    const repeated = await target.request('editor', 'submitUse', submitted, { signal })
    assert.equal(repeated.replayed, true)
    assert.deepEqual(repeated.usages, usage.usages)
    const historicalConsumer = await target.fixtures.createNode(target.workspaceId, 'claim', '显式历史回放目标。', { signal })
    const history = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: historicalConsumer, refs: snapshot.entries, mode: 'historical', snapshotId: snapshot.id }, { signal })
    assert.equal(history.entries[0]?.confidence, 0)
    assert.equal(history.entries[0]?.contentDigest, entry.contentDigest)
  }, scenario.setupTimeoutMs)
}

export async function runStressCase(
  /* 一档预先定义的合成场景。 */ scenario: StressScenario,
  /* 本例的在途业务操作数。 */ concurrency: number,
): Promise<void> {
  // 加载真实目标后才建立结果记录；本轮只编写函数，不调用它。
  assert.ok(scenario.concurrency.includes(concurrency))
  const context: Context = { pending: new Set(), calls: 0, peakDriverRssBytes: process.memoryUsage().rss, queryIds: new Set() }
  const environment: TestEnvironment = await bounded(context,
    /* 初始化取消信号。 */ signal => /* 只加载真实工厂。 */ createTestEnvironment(testBackend(), scenario.seed, { signal }), scenario.setupTimeoutMs)
  const target = environment.target
  const failures: unknown[] = [], thresholdFailures: string[] = []
  const rounds: RoundResult[] = [], telemetry: Telemetry[] = []
  let initialCounts: unknown = null, finalCounts: unknown = null
  try {
    const seeded = await bounded(context, /* 真实预置阶段取消信号。 */ signal => /* 准备真实隔离数据。 */ target.fixtures.seed({ seed: scenario.seed, entries: scenario.entries, usages: scenario.usages, textBytes: scenario.textBytes, hitEvery: scenario.hitEvery }, { signal }), scenario.setupTimeoutMs)
    assert.equal(seeded.entries, scenario.entries)
    assert.equal(seeded.usages, scenario.usages)
    assert.equal(seeded.entryRefs.length, scenario.entries)
    assert.equal(new Set(seeded.entryRefs.map(/* 真实预置身份。 */ ref => /* 检查预置重复。 */ ref.entryId)).size, scenario.entries)
    assert.equal(seeded.query, PRESSURE_QUERY)
    assert.equal(seeded.expectedQueryIds.length, Math.ceil(scenario.entries / scenario.hitEvery))
    context.queryIds = new Set(seeded.expectedQueryIds)
    assert.equal(context.queryIds.size, seeded.expectedQueryIds.length)
    assert.ok(seeded.sampleEntries.some(/* 已知输入对应的样本。 */ item => /* 错误陈述样本必需存在。 */ item.confidence === 0))
    assert.ok(seeded.sampleEntries.some(/* 已知输入对应的样本。 */ item => /* 正确陈述样本必需存在。 */ item.confidence === 1))
    initialCounts = await bounded(context, /* 准备后观测信号。 */ signal => /* 读取实际存储数量。 */ target.inspect.counts(target.workspaceId, { signal }), scenario.requestTimeoutMs)
    assert.ok(initialCounts !== null && typeof initialCounts === 'object' && 'entries' in initialCounts && 'usages' in initialCounts)
    assert.equal(initialCounts.entries, scenario.entries)
    assert.equal(initialCounts.usages, scenario.usages)
    const warmup = await prepareJobs(context, target, scenario, scenario.warmupOperations)
    const warmed = await measureRound(context, target, scenario, seeded, concurrency, warmup)
    assert.equal(warmed.succeeded, warmup.length)
    assert.equal(warmed.unfinishedCalls, 0)
    for (let round = 0; round < scenario.rounds; round += 1) {
      const jobs = await prepareJobs(context, target, scenario, scenario.operationsPerRound)
      telemetry.push(await bounded(context, /* 轮前观测信号。 */ signal => /* 读取实际目标内存和存储。 */ target.inspect.telemetry({ signal }), scenario.requestTimeoutMs))
      const result = await measureRound(context, target, scenario, seeded, concurrency, jobs)
      rounds.push(result)
      telemetry.push(await bounded(context, /* 轮后观测信号。 */ signal => /* 保留边界采样，不冒充瞬时峰值。 */ target.inspect.telemetry({ signal }), scenario.requestTimeoutMs))
      if (result.notStarted || result.unfinishedCalls || Object.values(result.operations).some(/* 真实操作桶。 */ bucket => /* 任一失败都禁止通过。 */ bucket.failed > 0)) {
        throw new Error(HarnessMessage.THRESHOLD_FAILED)
      }
    }
    await correctnessChecks(context, target, seeded, scenario)
    finalCounts = await bounded(context, /* 最终观测信号。 */ signal => /* 读取负载和校验后的实际数量。 */ target.inspect.counts(target.workspaceId, { signal }), scenario.requestTimeoutMs)
    telemetry.push(await bounded(context, /* 最后查询观测信号。 */ signal => /* 读取真实查询索引证据。 */ target.inspect.telemetry({ signal }), scenario.requestTimeoutMs))
    for (const [index, result] of rounds.entries()) {
      if (result.operationsPerSecond < scenario.thresholds.minSuccessOperationsPerSecond) thresholdFailures.push(`round${index}:throughput`)
      for (const operation of Object.keys(result.operations) as Operation[]) {
        const bucket = result.operations[operation], p95 = percentile(bucket.latenciesMs, 0.95), p99 = percentile(bucket.latenciesMs, 0.99)
        if (p95 === null || p99 === null || p95 > scenario.thresholds.maxP95Ms[operation] || p99 > scenario.thresholds.maxP99Ms[operation]) thresholdFailures.push(`round${index}:${operation}:latency`)
      }
    }
    if (context.peakDriverRssBytes > scenario.thresholds.maxDriverRssBytes) thresholdFailures.push('driver-rss')
    for (const sample of telemetry) {
      if (sample.storageBytes === null || sample.targetRssBytes === null) thresholdFailures.push('telemetry-unavailable')
      if (sample.targetRssBytes !== null && sample.targetRssBytes > scenario.thresholds.maxSampledTargetRssBytes) thresholdFailures.push('sampled-target-rss')
    }
    for (let index = 1; index < telemetry.length; index += 2) {
      const observed = telemetry[index]?.queryObservation
      if (!observed || observed.fullWorkspaceScan || !observed.indexNames.length) thresholdFailures.push(`round${Math.floor(index / 2)}:query-index-unverified`)
    }
    if (thresholdFailures.length) throw new Error(HarnessMessage.THRESHOLD_FAILED)
  } catch (error) { failures.push(error) }
  finally {
    try { await bounded(context, /* 独立清理期限信号。 */ signal => { /* 关闭真实目标并清理其隔离目录。 */ return environment.dispose({ signal }) }, scenario.cleanupTimeoutMs) }
    catch (error) { failures.push(error) }
  }
  if (context.pending.size) failures.push(failure('UNFINISHED_CALLS', HarnessMessage.PHASE_FAILED))
  const report = {
    status: failures.length ? 'failed' : 'passed', generatedAt: new Date().toISOString(), target: target.info,
    machine: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model ?? null, cpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
    scenario, concurrency, initialCounts, finalCounts, protocolCallAttempts: context.calls,
    protocolCallScope: 'warmup-and-measured-operations-only', admissionUnit: 'logical-business-operation',
    driverSampledMaxRssBytes: context.peakDriverRssBytes, telemetrySampling: 'round-boundaries', telemetry,
    unfinishedCalls: context.pending.size, thresholdFailures,
    failures: failures.map(/* 真实失败。 */ error => /* 保存分类和实际错误说明。 */ ({ code: errorCode(error), message: error instanceof Error ? error.message : String(error) })),
    rounds: rounds.map(/* 一轮实际测量。 */ result => /* 保留原始延迟及每类操作分位数。 */ ({ ...result,
      operations: Object.fromEntries(Object.entries(result.operations).map(/* 一类操作的计数。 */ ([operation, bucket]) => /* 失败也参与全体延迟统计。 */ [operation, { ...bucket, p50Ms: percentile(bucket.latenciesMs, 0.5), p95Ms: percentile(bucket.latenciesMs, 0.95), p99Ms: percentile(bucket.latenciesMs, 0.99) }])),
    })),
  }
  const directory = path.resolve(process.env.EVIDENCE_STRESS_REPORT_DIR ?? 'experiments/evidence-library-tests/results')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${scenario.name}-${target.info.backend}-c${concurrency}-${randomUUID()}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  if (failures.length) throw new AggregateError(failures, HarnessMessage.THRESHOLD_FAILED)
}
