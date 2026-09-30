// 将不可信输入解析为领域所需的对象、标识、版本及评分，拒绝额外字段。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { GraphError } from './domain-error'

/**
 * 验证普通对象及允许字段列表，返回已收窄对象，便于后续逐字段解析。
 *
 * @param value 尚未通过对象形状校验的边界输入。
 * @param keys 此对象唯一允许出现的字段名。
 * @param label 写入错误信息的字段路径。
 */
export function inputReadObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_OBJECT, label))
  const object = value as Record<string, unknown>
  const unknown = Object.keys(object).find(key => /* 找出白名单以外的字段，避免静默接受拼写错误或额外参数。 */ !keys.includes(key))
  if (unknown) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_VALUE_IS_NOT_ALLOWED, label, unknown))
  return object
}

/**
 * 要求非空白字符串，保留原文供调用方决定是否裁剪。
 *
 * @param value 尚未验证类型和空白内容的边界输入。
 * @param label 写入错误信息的字段路径。
 */
export function inputReadString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_A_NON_EMPTY_STRING, label))
  return value
}

/**
 * 要求符合 UUID 版本与变体格式的非空字符串，返回原标识。
 *
 * @param value 尚未验证 UUID 格式的边界输入。
 * @param label 写入错误信息的标识字段路径。
 */
export function inputReadId(value: unknown, label: string): string {
  const id = inputReadString(value, label)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_A_UUID, label))
  return id
}

/**
 * 仅接受非负安全整数，避免版本比较受负数、浮点数或精度损失影响。
 *
 * @param value 尚未验证整数范围的版本或计数输入。
 * @param label 写入错误信息的数值字段路径。
 */
export function inputReadRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_A_NON_NEGATIVE_INTEGER, label))
  return value
}

/**
 * 要求数组输入，元素的具体约束交由各业务解析器处理。
 *
 * @param value 尚未验证是否为数组的边界输入。
 * @param label 写入错误信息的数组字段路径。
 */
export function inputReadArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_ARRAY, label))
  return value
}

/**
 * 逐项校验 UUID，并在错误标签中保留数组下标。
 *
 * @param value 包含若干待校验 UUID 的边界输入。
 * @param label 写入错误信息的标识数组字段路径。
 */
export function inputReadIds(value: unknown, label: string): string[] {
  return inputReadArray(value, label).map((item, index) => /* 校验当前标识并标注其在输入数组中的位置。 */ inputReadId(item, `${label}[${index}]`))
}

/**
 * 逐项校验非空字符串，保留输入的顺序及原始文字。
 *
 * @param value 包含若干待校验名称的边界输入。
 * @param label 写入错误信息的名称数组字段路径。
 */
export function inputReadNames(value: unknown, label: string): string[] {
  return inputReadArray(value, label).map(item => /* 拒绝名称列表中的空项和非字符串。 */ inputReadString(item, label))
}

/**
 * 只接纳可信、不确定、不可信三档对应的评分值。
 *
 * @param value 尚未收窄到三档枚举的评分输入。
 */
export function inputReadScore(value: unknown): 0 | 0.5 | 1 {
  if (value !== 0 && value !== 0.5 && value !== 1) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.SCORE_MUST_BE_0_0_5_OR_1)
  return value
}
