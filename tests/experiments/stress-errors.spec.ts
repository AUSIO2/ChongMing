// 只验证压力驱动自身的失败统计与报告；模拟请求始终失败，不生成虚假成功性能结果。
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({ environment: vi.fn() }))
vi.mock('../../experiments/evidence-library-tests/load-target', () => ({
  /* 使用驱动原有目标加载 seam 注入受控失败，不模拟存储实现。 */ createTestEnvironment: seam.environment,
  /* 报告中的后端标签只属于本例失败驱动。 */ testBackend: () => 'mongo',
}))
import { runStressCase } from '../../experiments/evidence-library-tests/stress'
import { STRESS_SCENARIOS } from '../../experiments/evidence-library-tests/scenarios'
import { PRESSURE_QUERY } from '../../experiments/evidence-library-tests/fixtures'

afterEach(() => /* 报告目录仅在本例内使用。 */ vi.unstubAllEnvs())

it.each(['ordinary', 'constructor', '__proto__'])('preserves the original failure code %s as an own numeric counter', async (
  /* 目标服务可以返回的普通或原型同名错误码。 */ code,
) => {
  // 同一真实驱动调用必须失败；只检查失败报告能准确保留类别，不宣称真实业务通过。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-driver-errors-'))
  vi.stubEnv('EVIDENCE_STRESS_REPORT_DIR', directory)
  const dispose = vi.fn(async () => { /* 本例目标没有外部资源。 */ })
  seam.environment.mockResolvedValue({ dispose, target: {
    info: { name: 'controlled failing driver target', backend: 'mongo', executionModel: 'remote', isolated: true }, workspaceId: 'workspace',
    fixtures: { seed: async () => ({ entries: 2, usages: 0, entryRefs: [{ entryId: 'entry-a', contentDigest: 'a' }, { entryId: 'entry-b', contentDigest: 'b' }],
      sampleEntries: [{ confidence: 0 }, { confidence: 1 }], query: PRESSURE_QUERY, expectedQueryIds: ['entry-a'] }) },
    inspect: { counts: async () => ({ entries: 2, usages: 0 }), telemetry: async () => ({ storageBytes: 0, targetRssBytes: 0, queryObservation: null }) },
    request: async () => { /* 请求明确失败，驱动不能把它计为成功。 */ throw Object.assign(new Error('controlled request failure'), { code }) },
  } })
  try {
    await expect(runStressCase({ ...STRESS_SCENARIOS[0], entries: 2, usages: 0, hitEvery: 2, concurrency: [1], warmupOperations: 0,
      operationsPerRound: 1, rounds: 1, maxOperationsPerSecond: 1000 }, 1)).rejects.toBeInstanceOf(AggregateError)
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    const report = JSON.parse(await readFile(path.join(directory, files[0]), 'utf8'))
    expect(report.status).toBe('failed')
    const bucket = report.rounds[0].operations.search
    expect(bucket.failed).toBe(1)
    expect(bucket.succeeded).toBe(0)
    expect(Object.hasOwn(bucket.errors, code)).toBe(true)
    expect(bucket.errors[code]).toBe(1)
    expect(dispose).toHaveBeenCalledOnce()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
