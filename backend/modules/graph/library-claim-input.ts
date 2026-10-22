// 校验通用图元信息中的固定库引用，不在图规则内查询证据库实时状态。
import { EvidenceMessage, type EvidenceLibraryRef, type EvidenceUseRef } from '../../../contracts/evidence-library'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadObject } from '../shared/input-validation'

const MAX_LIBRARY_REFS = 32
const MAX_REASON_BYTES = 64 * 1024

export function graphInputReadLibraryClaimRefs(
  /* HTTP、存储或直接图调用交付的尚未校验数组。 */ value: unknown,
  /* 报错定位所使用的具体图字段路径。 */ label: string,
): EvidenceLibraryRef[] {
  // 验证有界、无重复的精确库身份，返回与原数组解除引用的值。
  return readRefs(value, label, false)
}

export function graphInputReadLibraryUseRefs(
  /* 待写入节点或候选的未知库使用元信息。 */ value: unknown,
  /* 当前节点或输出字段的具体路径。 */ label: string,
): EvidenceUseRef[] {
  // 每个引用保存明确非空理由，省略/空数组的语义由节点写入主流程决定。
  return readRefs(value, label, true)
}

function readRefs(
  /* 尚未通过数组和元素校验的引用集合。 */ value: unknown,
  /* 需要写入校验错误的字段路径。 */ label: string,
  /* false 只接纳选材身份，不允许附带使用理由。 */ hasReason: false,
): EvidenceLibraryRef[]
function readRefs(value: unknown, label: string, hasReason: true): EvidenceUseRef[]
function readRefs(
  /* 尚未通过数组和元素校验的引用集合。 */ value: unknown,
  /* 需要写入校验错误的字段路径。 */ label: string,
  /* true 要求使用理由，false 仅接纳选材身份。 */ hasReason: boolean,
): Array<EvidenceLibraryRef | EvidenceUseRef> {
  // 在一次遍历内验证固定身份及可选使用理由，拒绝同一条目的重复引用。
  if (!Array.isArray(value)) throw new GraphError(422, 'INVALID_ARGUMENT', EvidenceMessage.INPUT_INVALID)
  if (value.length > MAX_LIBRARY_REFS) throw new GraphError(422, 'EVIDENCE_SELECTION_LIMIT', EvidenceMessage.SELECTION_LIMIT)
  const ids = new Set<string>()
  return value.map((/* 单项尚未校验的引用对象。 */ raw, /* 数组元素位置。 */ index) => {
    // 身份只能是UUID与SHA-256，其他库字段不能借元信息进入图。
    const item = inputReadObject(raw, hasReason ? ['entryId', 'contentDigest', 'reason'] : ['entryId', 'contentDigest'], `${label}[${index}]`)
    const entryId = inputReadId(item.entryId, `${label}[${index}].entryId`)
    if (typeof item.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.contentDigest)) throw new GraphError(422, 'EVIDENCE_DIGEST_MISMATCH', EvidenceMessage.DIGEST_MISMATCH)
    if (ids.has(entryId)) throw new GraphError(422, 'INVALID_ARGUMENT', EvidenceMessage.INPUT_INVALID)
    ids.add(entryId)
    if (hasReason) {
      if (typeof item.reason !== 'string' || !item.reason.trim()) throw new GraphError(422, 'EVIDENCE_USE_REASON_REQUIRED', EvidenceMessage.USE_REASON_REQUIRED)
      if (Buffer.byteLength(item.reason) > MAX_REASON_BYTES) throw new GraphError(413, 'EVIDENCE_INPUT_LIMIT', EvidenceMessage.INPUT_LIMIT)
      return { entryId, contentDigest: item.contentDigest, reason: item.reason.trim() }
    }
    return { entryId, contentDigest: item.contentDigest }
  })
}
