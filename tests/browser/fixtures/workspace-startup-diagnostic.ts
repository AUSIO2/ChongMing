// 恢复测试的私有启动诊断：只传固定阶段和代码，不复制底层异常、路径或凭据。
export enum RecoveryStartupStage {
  STORAGE = 'storage',
  INITIALIZE = 'initialize',
  IDENTITY = 'identity',
  MESSAGING = 'messaging',
  HTTP = 'http',
}

export enum RecoveryStartupDiagnosticCode {
  EEXIST = 'EEXIST',
  ENOTDIR = 'ENOTDIR',
  EACCES = 'EACCES',
  ECONNREFUSED = 'ECONNREFUSED',
  ENOENT = 'ENOENT',
  EADDRINUSE = 'EADDRINUSE',
  UNREGISTERED = 'unregistered',
}

export interface RecoveryStartupDiagnostic {
  readonly stage: RecoveryStartupStage
  readonly code: RecoveryStartupDiagnosticCode
}

enum RecoveryDiagnosticMessage { STARTUP_PREFIX = 'recovery-startup' }

const stages = new Set<string>(Object.values(RecoveryStartupStage))
const codes = new Set<string>(Object.values(RecoveryStartupDiagnosticCode))

export function recoveryCreateStartupDiagnostic(
  /* child 已进入的固定启动阶段，不接收异常正文中的阶段名称。 */ stage: RecoveryStartupStage,
  /* 真实启动异常；只读取自身数据属性中的原生 code。 */ error: unknown,
): RecoveryStartupDiagnostic {
  // 未登记或无结构化code的异常统一降为固定值，底层message与stack没有传输路径。
  const descriptor = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined
  const code: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
  return { stage, code: typeof code === 'string' && codes.has(code) ? code as RecoveryStartupDiagnosticCode : RecoveryStartupDiagnosticCode.UNREGISTERED }
}

export function recoveryReadStartupDiagnostic(
  /* 父收到的未知私有IPC诊断，尚未通过固定字段与枚举验证。 */ value: unknown,
): RecoveryStartupDiagnostic | undefined {
  // 恰好stage/code两个自身数据属性才接纳，额外键、访问器和未知值整份拒绝。
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('stage') || !keys.includes('code')) return undefined
  const stage = Object.getOwnPropertyDescriptor(value, 'stage'), code = Object.getOwnPropertyDescriptor(value, 'code')
  if (!stage || !('value' in stage) || typeof stage.value !== 'string' || !stages.has(stage.value)
    || !code || !('value' in code) || typeof code.value !== 'string' || !codes.has(code.value)) return undefined
  return { stage: stage.value as RecoveryStartupStage, code: code.value as RecoveryStartupDiagnosticCode }
}

export function recoveryCreateStartupDiagnosticCause(
  /* 由本模块构造或验证的固定诊断，不接受底层异常作为cause。 */ diagnostic: RecoveryStartupDiagnostic,
): Error {
  // 使用真正Error保留Playwright的cause链，message仅由私有固定前缀与枚举值组成。
  return new Error(`${RecoveryDiagnosticMessage.STARTUP_PREFIX}:${diagnostic.stage}:${diagnostic.code}`)
}
