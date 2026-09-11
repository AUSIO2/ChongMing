import { GraphError } from './graph-error'

export function inputReadObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be an object`)
  const object = value as Record<string, unknown>
  const unknown = Object.keys(object).find(key => !keys.includes(key))
  if (unknown) throw new GraphError(400, 'INVALID_ARGUMENT', `${label}.${unknown} is not allowed`)
  return object
}

export function inputReadString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be a non-empty string`)
  return value
}

export function inputReadId(value: unknown, label: string): string {
  const id = inputReadString(value, label)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be a UUID`)
  return id
}

export function inputReadRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be a non-negative integer`)
  return value
}

export function inputReadArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be an array`)
  return value
}

export function inputReadIds(value: unknown, label: string): string[] {
  return inputReadArray(value, label).map((item, index) => inputReadId(item, `${label}[${index}]`))
}

export function inputReadNames(value: unknown, label: string): string[] {
  return inputReadArray(value, label).map(item => inputReadString(item, label))
}

export function inputReadScore(value: unknown): 0 | 0.5 | 1 {
  if (value !== 0 && value !== 0.5 && value !== 1) throw new GraphError(400, 'INVALID_ARGUMENT', 'score must be 0, 0.5 or 1')
  return value
}
