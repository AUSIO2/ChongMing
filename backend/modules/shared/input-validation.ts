import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { GraphError } from './domain-error'

// 用途：读取对象，并把结构化结果交给调用方。
export function inputReadObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_OBJECT, label))
  const object = value as Record<string, unknown>
  const unknown = Object.keys(object).find(key => !keys.includes(key))
  if (unknown) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_VALUE_IS_NOT_ALLOWED, label, unknown))
  return object
}

// 用途：读取字符串，并把结构化结果交给调用方。
export function inputReadString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_A_NON_EMPTY_STRING, label))
  return value
}

// 用途：读取标识，并把结构化结果交给调用方。
export function inputReadId(value: unknown, label: string): string {
  const id = inputReadString(value, label)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_A_UUID, label))
  return id
}

// 用途：读取版本，并把结构化结果交给调用方。
export function inputReadRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_A_NON_NEGATIVE_INTEGER, label))
  return value
}

// 用途：读取数组，并把结构化结果交给调用方。
export function inputReadArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_ARRAY, label))
  return value
}

// 用途：读取标识，并把结构化结果交给调用方。
export function inputReadIds(value: unknown, label: string): string[] {
  return inputReadArray(value, label).map((item, index) => inputReadId(item, `${label}[${index}]`))
}

// 用途：读取名称，并把结构化结果交给调用方。
export function inputReadNames(value: unknown, label: string): string[] {
  return inputReadArray(value, label).map(item => inputReadString(item, label))
}

// 用途：读取输入，并把结构化结果交给调用方。
export function inputReadScore(value: unknown): 0 | 0.5 | 1 {
  if (value !== 0 && value !== 0.5 && value !== 1) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.SCORE_MUST_BE_0_0_5_OR_1)
  return value
}
