// 加载未来的真实实现工厂；缺失时失败，绝不回退到参考实现。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HarnessMessage, type CallOptions, type EvidenceTestTarget, type TargetOptions, type TestBackend } from './test-contract'

function isRecord(
  /* 尚未验证的动态模块或工厂结果。 */ value: unknown,
): value is Record<string, unknown> {
  // 拒绝 null 和数组，让后续结构检查只访问普通记录。
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertTarget(
  /* 真实工厂返回但尚未验证的接入对象。 */ value: unknown,
  /* 本次请求的后端种类。 */ backend: TestBackend,
): asserts value is EvidenceTestTarget {
  // 只验证接入能力存在，不替业务实现校验输入或生成结果。
  if (!isRecord(value) || !isRecord(value.info) || value.info.isolated !== true
    || value.info.backend !== backend || typeof value.info.name !== 'string' || !value.info.name.trim()
    || value.info.executionModel !== 'single-owner' && value.info.executionModel !== 'pooled' && value.info.executionModel !== 'remote'
    || typeof value.workspaceId !== 'string' || typeof value.otherWorkspaceId !== 'string'
    || !value.workspaceId || !value.otherWorkspaceId
    || value.workspaceId === value.otherWorkspaceId || typeof value.request !== 'function'
    || typeof value.close !== 'function' || !isRecord(value.fixtures) || !isRecord(value.inspect)) {
    throw new Error(HarnessMessage.TARGET_INVALID)
  }
  const fixtures = value.fixtures
  const fixtureMethods = ['createNode', 'updateClaim', 'deleteClaim', 'deleteMap', 'createAsset', 'deleteAsset', 'revoke', 'failNextCommit', 'seed']
  if (fixtureMethods.some(
    /* 必需的真实环境准备或故障注入能力名称。 */ name =>
      /* 缺少能力就拒绝接入，不能跳过相应测试。 */ typeof fixtures[name] !== 'function',
  ) || typeof value.inspect.counts !== 'function' || typeof value.inspect.telemetry !== 'function') {
    throw new Error(HarnessMessage.TARGET_INVALID)
  }
}

export function testBackend(): TestBackend {
  // MongoDB 是证据库的选定主目标；这里只选择未来目标，不创建连接。
  const backend = process.env.EVIDENCE_TEST_BACKEND ?? 'mongo'
  if (backend !== 'sqlite' && backend !== 'mongo') throw new Error(HarnessMessage.BACKEND_INVALID)
  return backend
}

export interface TestEnvironment { target: EvidenceTestTarget; dispose(/* 关闭独立期限。 */ options?: CallOptions): Promise<void> }

export async function createTestEnvironment(
  /* 功能测试或压测选择的实际后端。 */ backend: TestBackend = testBackend(),
  /* 用于确定性准备数据的随机种子。 */ seed = 20261006,
  /* 初始化阶段的取消信号。 */ callOptions?: CallOptions,
): Promise<TestEnvironment> {
  // 必须显式指定实现模块，工厂负责实际身份、临时库和传输接入。
  const configured = process.env.EVIDENCE_TEST_TARGET
  callOptions?.signal?.throwIfAborted()
  if (!configured) throw new Error(HarnessMessage.TARGET_REQUIRED)
  const filename = configured.startsWith('file:') ? fileURLToPath(configured) : path.resolve(configured)
  const loaded: unknown = await import(pathToFileURL(filename).href)
  if (!isRecord(loaded) || typeof loaded.createEvidenceTestTarget !== 'function') {
    throw new Error(HarnessMessage.FACTORY_REQUIRED)
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-evidence-test-'))
  const options: TargetOptions = { backend, directory, seed, signal: callOptions?.signal }
  let target: EvidenceTestTarget
  let candidate: unknown
  try {
    candidate = await loaded.createEvidenceTestTarget(options)
    assertTarget(candidate, backend)
    callOptions?.signal?.throwIfAborted()
    target = candidate
  } catch (error) {
    const errors: unknown[] = [error]
    if (isRecord(candidate) && typeof candidate.close === 'function') {
      try { await candidate.close({ signal: AbortSignal.timeout(10_000) }) }
      catch (closeError) { errors.push(closeError) }
    }
    try { await rm(directory, { recursive: true, force: true }) }
    catch (cleanupError) { errors.push(cleanupError) }
    if (errors.length > 1) throw new AggregateError(errors, HarnessMessage.CLEANUP_FAILED)
    throw error
  }
  return { target, async dispose(/* 目标关闭必须遵守的独立期限。 */ closeOptions) {
    // 两个清理阶段的错误分别保留，不能用目录清理失败覆盖目标关闭失败。
    const errors: unknown[] = []
    try { await target.close(closeOptions) } catch (error) { errors.push(error) }
    try { await rm(directory, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, HarnessMessage.CLEANUP_FAILED)
  } }
}
