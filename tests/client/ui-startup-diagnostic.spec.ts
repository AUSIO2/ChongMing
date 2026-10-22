// 启动诊断的轻量合同：保留字段、脱敏和安全 cause 检查，不再启动故障子 runner。
import { describe, expect, it } from 'vitest'

import {
  RecoveryStartupDiagnosticCode,
  RecoveryStartupStage,
  recoveryCreateStartupDiagnostic,
  recoveryCreateStartupDiagnosticCause,
  recoveryReadStartupDiagnostic,
} from '../browser/fixtures/workspace-startup-diagnostic'

describe('测试启动诊断合同', () => {
  // 维护安全 DTO 的公开行为，完整 IPC/进程退出资格已由用户决定暂缓。
  it('固定原生码与阶段可读回，cause 不包含底层错误正文', () => {
    // 路径及凭据形状只存在于输入，输出应仅包含固定枚举。
    const original = Object.assign(new Error('private-path-and-token'), { code: 'EEXIST' })
    const diagnostic = recoveryCreateStartupDiagnostic(RecoveryStartupStage.STORAGE, original)
    expect(diagnostic).toEqual({ stage: RecoveryStartupStage.STORAGE, code: RecoveryStartupDiagnosticCode.EEXIST })
    expect(recoveryReadStartupDiagnostic(diagnostic)).toEqual(diagnostic)
    const cause = recoveryCreateStartupDiagnosticCause(diagnostic)
    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toBe('recovery-startup:storage:EEXIST')
    expect(cause.cause).toBeUndefined()
  })

  it('未知原生码降级且不执行错误对象上的访问器', () => {
    // 不读取远端错误正文或 getter，即使 getter 返回已登记代码也不执行。
    let reads = 0
    const accessor = { get code(): string { /* 访问器不属于允许的原生数据属性。 */ reads++; return 'EEXIST' } }
    for (const original of [null, { code: 'private-code', message: 'private-token' }, accessor]) {
      expect(recoveryCreateStartupDiagnostic(RecoveryStartupStage.HTTP, original)).toEqual({
        stage: RecoveryStartupStage.HTTP, code: RecoveryStartupDiagnosticCode.UNREGISTERED,
      })
    }
    expect(reads).toBe(0)
  })

  it('拒绝额外字段、未知枚举和非数据属性', () => {
    // 参数化输入集中验证投影边界，避免为每种形状创建一套进程环境。
    const valid = { stage: 'storage', code: 'EEXIST' }
    const rejected: unknown[] = [null, [], { ...valid, token: 'private-token' },
      { ...valid, stage: 'unknown' }, { ...valid, code: 'private-code' },
      { ...valid, [Symbol('extra')]: true },
      { get stage(): string { /* 访问器即使值正确也不属于数据属性。 */ return 'storage' }, code: 'EEXIST' }]
    for (const value of rejected) expect(recoveryReadStartupDiagnostic(value)).toBeUndefined()
  })
})
