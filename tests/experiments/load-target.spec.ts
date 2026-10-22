// 验证动态工厂的 unknown 枚举边界；替身只提供接入能力，不实现证据业务。
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const factory = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../experiments/evidence-library-tests/mongo-target', () => ({
  /* 返回本例明确指定的未知工厂结果。 */ createEvidenceTestTarget: factory.create,
}))
import { HarnessMessage } from '../../experiments/evidence-library-tests/test-contract'
import { createTestEnvironment } from '../../experiments/evidence-library-tests/load-target'

afterEach(() => /* 恢复动态工厂定位变量。 */ vi.unstubAllEnvs())

it.each([['remote'], 'remote', 'pooled', 'single-owner'])('accepts only a scalar executionModel: %s', async (
  /* 真实枚举对照，数组是故意提供的未知边界输入。 */ executionModel,
) => {
  // 数组不能经 String 转换取得合法枚举身份，拒绝时仍关闭已取得的工厂资源。
  vi.stubEnv('EVIDENCE_TEST_TARGET', path.resolve('experiments/evidence-library-tests/mongo-target.ts'))
  const close = vi.fn(async () => { /* 释放这个测试拥有的工厂资源。 */ })
  const unused = async () => { /* 本例不进行任何业务请求或数据准备。 */ }
  factory.create.mockResolvedValue({ info: { name: 'boundary probe', isolated: true, backend: 'mongo', executionModel },
    workspaceId: 'workspace', otherWorkspaceId: 'other', request: unused, close,
    fixtures: { createNode: unused, updateClaim: unused, deleteClaim: unused, deleteMap: unused, createAsset: unused,
      deleteAsset: unused, revoke: unused, failNextCommit: unused, seed: unused },
    inspect: { counts: unused, telemetry: unused } })
  if (Array.isArray(executionModel)) {
    await expect(createTestEnvironment('mongo')).rejects.toThrow(HarnessMessage.TARGET_INVALID)
    expect(close).toHaveBeenCalledOnce()
  } else {
    const environment = await createTestEnvironment('mongo')
    try { expect(environment.target.info.executionModel).toBe(executionModel) }
    finally { await environment.dispose() }
    expect(close).toHaveBeenCalledOnce()
  }
})
