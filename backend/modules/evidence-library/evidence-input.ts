// 校验证据库的输入白名单、固定判断、范围与引用，不访问来源或持久化记录。
import { EvidenceMessage, type EvidenceApplicability, type EvidenceBasisRef, type EvidenceClaimRef, type EvidenceCollectParams, type EvidenceCommand, type EvidenceQuery, type EvidenceSearchParams } from '../../../contracts/evidence-library'
import { GraphError } from '../shared/domain-error'
import type { InputCommandEnvelope, InputQueryEnvelope } from '../shared/input-validation'

const INPUT_BYTES = 262_144
const TEXT_BYTES = 65_536
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface EvidenceCommandEnvelope {
  method: EvidenceCommand['method']
  requestId: string
  params: Record<string, unknown> & { workspaceId: string }
}
export type EvidenceParsedCommand =
  | { method: 'evidence.collect'; requestId: string; params: EvidenceCollectParams & { confidence: 0 | 1 } }
  | Extract<EvidenceCommand, { method: 'evidence.withdraw' }>

export function evidenceReadEnvelope(
  /* 明确收录意图的未知命令，仍完整校验信封与固定授权范围。 */
  value: { method: 'evidence.collect'; requestId: unknown; params: unknown },
): EvidenceCommandEnvelope & { method: 'evidence.collect' }
export function evidenceReadEnvelope(
  /* 来自独立服务入口、方法仍未知的完整命令。 */ value: unknown,
): EvidenceCommandEnvelope
export function evidenceReadEnvelope(
  /* 来自传输或内部调用、尚未解析固定字段的完整命令。 */
  value: unknown,
): EvidenceCommandEnvelope {
  // 先读取幂等身份和授权范围，使已接受命令无需重查来源即可重放。
  const input = readObject(value, ['method', 'requestId', 'params'])
  assertInputSize(value)
  if (input.method !== 'evidence.collect' && input.method !== 'evidence.withdraw') {
    throw new GraphError(501, 'EVIDENCE_NOT_IMPLEMENTED', EvidenceMessage.NOT_IMPLEMENTED)
  }
  return readCommandParams(input.method, readId(input.requestId), input.params)
}

export function evidenceReadCommandEnvelope(
  /* HTTP 已确认白名单与请求 UUID 的命令，固定业务字段仍未解析。 */
  input: InputCommandEnvelope,
): EvidenceCommandEnvelope {
  // 传输信封不重复解析；证据库仍拥有独立体积与授权范围边界。
  assertInputSize(input)
  if (input.method !== 'evidence.collect' && input.method !== 'evidence.withdraw') {
    throw new GraphError(501, 'EVIDENCE_NOT_IMPLEMENTED', EvidenceMessage.NOT_IMPLEMENTED)
  }
  return readCommandParams(input.method, input.requestId, input.params)
}

function readCommandParams(
  /* 所属入口已经确认的证据写命令方法。 */ method: EvidenceCommand['method'],
  /* 所属入口已经验证的请求 UUID。 */ requestId: string,
  /* 仍待确认对象形状与工作区身份的业务参数。 */ value: unknown,
): EvidenceCommandEnvelope {
  // 两个真实入口共用授权范围读取，来源及固定字段检查留在收据之后。
  const params = readObject(value)
  return { method, requestId, params: { ...params, workspaceId: readId(params.workspaceId) } }
}

export function evidenceReadCommand(envelope: EvidenceCommandEnvelope & { method: 'evidence.collect' }): Extract<EvidenceParsedCommand, { method: 'evidence.collect' }>
export function evidenceReadCommand(envelope: EvidenceCommandEnvelope): EvidenceParsedCommand
export function evidenceReadCommand(
  /* 已建立幂等身份与授权范围、业务参数仍待逐项解析的信封。 */
  envelope: EvidenceCommandEnvelope,
): EvidenceParsedCommand {
  // 只为未命中收据的新命令解析固定字段，保留信封阶段已确认的身份和体积。
  if (envelope.method === 'evidence.collect') {
    const params = envelope.params
    assertKeys(params, ['workspaceId', 'claim', 'confidence', 'applicability', 'reason', 'basisRefs'])
    return { method: envelope.method, requestId: envelope.requestId, params: {
      workspaceId: envelope.params.workspaceId, claim: readClaimRef(params.claim), confidence: readConfidence(params.confidence),
      applicability: readApplicability(params.applicability), reason: readReason(params.reason), basisRefs: readBasisRefs(params.basisRefs),
    } }
  }
  const params = envelope.params
  assertKeys(params, ['workspaceId', 'entryId', 'expectedRevision', 'reason'])
  return { method: envelope.method, requestId: envelope.requestId, params: {
    workspaceId: envelope.params.workspaceId, entryId: readId(params.entryId), expectedRevision: readRevision(params.expectedRevision), reason: readReason(params.reason),
  } }
}

export function evidenceReadQuery(
  /* 需要校验身份、筛选条件和页大小的公共读查询。 */
  input: InputQueryEnvelope,
): EvidenceQuery {
  // 固定条目与关系共用精确身份边界，有界搜索保留数字零作为有效筛选条件。
  assertInputSize(input)
  if (input.method === 'evidence.get' || input.method === 'evidence.relations') {
    const params = readObject(input.params, ['workspaceId', 'entryId'])
    return { method: input.method, params: { workspaceId: readId(params.workspaceId), entryId: readId(params.entryId) } }
  }
  if (input.method === 'evidence.use.get') {
    const params = readObject(input.params, ['workspaceId', 'entryId', 'usageId'])
    return { method: input.method, params: { workspaceId: readId(params.workspaceId), entryId: readId(params.entryId), usageId: readId(params.usageId) } }
  }
  if (input.method === 'evidence.uses') {
    const params = readObject(input.params, ['workspaceId', 'entryId', 'includeHistory', 'cursor', 'limit'])
    const result: Extract<EvidenceQuery, { method: 'evidence.uses' }>['params'] = {
      workspaceId: readId(params.workspaceId), entryId: readId(params.entryId),
    }
    if (params.includeHistory !== undefined) {
      if (typeof params.includeHistory !== 'boolean') failInput()
      result.includeHistory = params.includeHistory
    }
    if (params.cursor !== undefined) result.cursor = readText(params.cursor, 4096)
    if (params.limit !== undefined) {
      if (typeof params.limit !== 'number' || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
        throw new GraphError(422, 'EVIDENCE_QUERY_LIMIT_INVALID', EvidenceMessage.QUERY_LIMIT_INVALID)
      }
      result.limit = params.limit
    }
    return { method: input.method, params: result }
  }
  if (input.method !== 'evidence.search') throw new GraphError(501, 'EVIDENCE_NOT_IMPLEMENTED', EvidenceMessage.NOT_IMPLEMENTED)
  const params = readObject(input.params, ['workspaceId', 'query', 'confidence', 'subject', 'event', 'cursor', 'limit', 'includeInactive'])
  const result: EvidenceSearchParams = { workspaceId: readId(params.workspaceId) }
  if (params.query !== undefined) result.query = readText(params.query, 4096, true)
  if (params.confidence !== undefined) result.confidence = readConfidence(params.confidence)
  if (params.subject !== undefined) result.subject = readText(params.subject, 4096)
  if (params.event !== undefined) result.event = readText(params.event, 4096)
  if (params.cursor !== undefined) result.cursor = readText(params.cursor, 4096)
  if (params.limit !== undefined) {
    if (typeof params.limit !== 'number' || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
      throw new GraphError(422, 'EVIDENCE_QUERY_LIMIT_INVALID', EvidenceMessage.QUERY_LIMIT_INVALID)
    }
    result.limit = params.limit
  }
  if (params.includeInactive !== undefined) {
    if (typeof params.includeInactive !== 'boolean') failInput()
    result.includeInactive = params.includeInactive
  }
  return { method: input.method, params: result }
}

function readObject(
  /* 需要检查普通对象形状的未可信输入。 */
  value: unknown,
  /* 对象允许出现的字段；省略时仅检查形状以读取幂等信封。 */
  keys?: readonly string[],
): Record<string, unknown> {
  // 拒绝数组及非普通对象，使用可选字段白名单阻止夹带固定内容修改。
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) failInput()
  const object = value as Record<string, unknown>
  if (keys) assertKeys(object, keys)
  return object
}

function assertKeys(
  /* 当前入口已建立普通对象形状的参数或依据。 */ object: Record<string, unknown>,
  /* 当前业务分支唯一允许的自有字段。 */ keys: readonly string[],
): void {
  // 只检查字段归属，已收窄对象不再重复验证形状。
  for (const key of Object.keys(object)) if (!keys.includes(key)) failInput()
}

function readId(
  /* 外部声明的工作区、来源或请求 UUID。 */
  value: unknown,
): string {
  // 按现有身份约定校验 UUID，并保留调用方的原始字符串。
  if (typeof value !== 'string' || !UUID.test(value)) failInput()
  return value
}

function readText(
  /* 需要保存原文或用作筛选的外部字符串。 */
  value: unknown,
  /* 此字段允许的最大 UTF-8 字节数。 */
  maxBytes = TEXT_BYTES,
  /* 搜索正文是否允许显式空字符串。 */
  allowEmpty = false,
): string {
  // 不裁剪正文；只判断空白内容和字节上限，避免改变收录材料。
  if (typeof value !== 'string' || !allowEmpty && !value.trim()) failInput()
  assertTextSize(value, maxBytes)
  return value
}

function assertTextSize(
  /* 已建立内容规则、将原样保存的字符串。 */ value: string,
  /* 当前字段允许的最大 UTF-8 字节数。 */ maxBytes: number,
): void {
  // 理由和一般文本共用体积边界，空白错误仍由各自字段决定。
  if (Buffer.byteLength(value) > maxBytes) throw new GraphError(413, 'EVIDENCE_INPUT_LIMIT', EvidenceMessage.INPUT_LIMIT)
}

function readRevision(
  /* 来源或管理命令声明的非负内容版本。 */
  value: unknown,
): number {
  // 拒绝负数、浮点数和不可精确表示的版本。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) failInput()
  return value
}

function readConfidence(
  /* 需要显式选择完全错误或完全正确的固定判断。 */
  value: unknown,
): 0 | 1 {
  // 仅接受数字零和一，不接受字符串、布尔值或缺省值。
  if (value !== 0 && value !== 1) throw new GraphError(422, 'EVIDENCE_CONFIDENCE_INVALID', EvidenceMessage.CONFIDENCE_INVALID)
  return value
}

function readReason(
  /* 收录或撤回决定的人工理由原文。 */
  value: unknown,
): string {
  // 理由必须有实际内容，但保存时保留用户原文。
  if (typeof value !== 'string' || !value.trim()) throw new GraphError(422, 'EVIDENCE_REASON_REQUIRED', EvidenceMessage.REASON_REQUIRED)
  assertTextSize(value, TEXT_BYTES)
  return value
}

function readClaimRef(
  /* 指向同一工作区内图节点精确版本的外部引用。 */
  value: unknown,
): EvidenceClaimRef {
  // 图和节点共同构成来源身份，节点版本不回落到当前最新版。
  const input = readObject(value, ['mapId', 'nodeId', 'revision'])
  return { mapId: readId(input.mapId), nodeId: readId(input.nodeId), revision: readRevision(input.revision) }
}

function readApplicability(
  /* 包含显式未知值的固定适用范围。 */
  value: unknown,
): EvidenceApplicability {
  // 未知范围保持 null；明确时间、条件和对象原样保存，避免扩大适用性。
  const input = readObject(value, ['subject', 'event', 'time', 'place', 'conditions'])
  let time: EvidenceApplicability['time'] = null
  if (input.time !== null) {
    const range = readObject(input.time, ['from', 'to'])
    const from = readText(range.from, 128), to = readText(range.to, 128)
    const fromTime = Date.parse(from), toTime = Date.parse(to)
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime > toTime) failInput()
    time = { from, to }
  }
  if (!Array.isArray(input.conditions) || input.conditions.length > 64) failInput()
  const conditions: string[] = []
  for (const condition of input.conditions) conditions.push(readText(condition, 4096))
  return { subject: input.subject === null ? null : readText(input.subject, 4096),
    event: input.event === null ? null : readText(input.event, 4096), place: input.place === null ? null : readText(input.place, 4096), time, conditions }
}

function readBasisRefs(
  /* 收录判断需要固定的人工、节点、资产或库内依据引用。 */
  value: unknown,
): EvidenceBasisRef[] {
  // 按引用类别拒绝多余字段，外部材料的存在性与摘要留给授权事务检查。
  if (!Array.isArray(value) || value.length > 64) failInput()
  const refs: EvidenceBasisRef[] = []
  for (const item of value) {
    const input = readObject(item)
    if (input.kind === 'manual') {
      assertKeys(input, ['kind', 'text'])
      refs.push({ kind: input.kind, text: readText(input.text) })
    } else if (input.kind === 'node') {
      assertKeys(input, ['kind', 'ref'])
      refs.push({ kind: input.kind, ref: readClaimRef(input.ref) })
    } else if (input.kind === 'asset') {
      assertKeys(input, ['kind', 'assetId', 'sha256'])
      refs.push({ kind: input.kind, assetId: readId(input.assetId), sha256: readDigest(input.sha256) })
    } else if (input.kind === 'library') {
      assertKeys(input, ['kind', 'ref'])
      const ref = readObject(input.ref, ['entryId', 'contentDigest'])
      refs.push({ kind: input.kind, ref: { entryId: readId(ref.entryId), contentDigest: readDigest(ref.contentDigest) } })
    } else failInput()
  }
  return refs
}

function readDigest(
  /* 固定材料声明的完整 SHA-256 摘要。 */
  value: unknown,
): string {
  // 摘要必须已经采用小写十六进制格式，保证固定输入没有隐式改写。
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new GraphError(422, 'EVIDENCE_BASIS_INVALID', EvidenceMessage.BASIS_INVALID)
  return value
}

function assertInputSize(
  /* 准备解析为持久化命令或查询的原始边界对象。 */
  value: unknown,
): void {
  // 限制整个 JSON 输入体，序列化失败也按输入错误拒绝。
  let encoded: string | undefined
  try { encoded = JSON.stringify(value) } catch { failInput() }
  if (encoded === undefined) failInput()
  if (Buffer.byteLength(encoded) > INPUT_BYTES) throw new GraphError(413, 'EVIDENCE_INPUT_LIMIT', EvidenceMessage.INPUT_LIMIT)
}

function failInput(): never {
  // 统一公开字段错误，避免解析器输出拼接的运行时消息。
  throw new GraphError(400, 'INVALID_ARGUMENT', EvidenceMessage.INPUT_INVALID)
}
