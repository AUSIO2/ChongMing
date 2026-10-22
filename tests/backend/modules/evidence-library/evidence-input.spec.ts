// 验证证据输入的分阶段字段约束、理由错误和时间范围，复用已收窄对象后不放宽边界。
import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { EvidenceCollectParams } from '../../../../contracts/evidence-library'
import { evidenceReadCommand, evidenceReadEnvelope } from '../../../../backend/modules/evidence-library/evidence-input'

function collectParams(): EvidenceCollectParams {
  // 提供全部合法固定字段，负例只改动当前要验证的条件。
  return { workspaceId: randomUUID(), claim: { mapId: randomUUID(), nodeId: randomUUID(), revision: 0 }, confidence: 0,
    reason: ' 保留原文 ', applicability: { subject: null, event: null, time: { from: '2026-01-01', to: '2026-12-31' }, place: null, conditions: [] },
    basisRefs: [{ kind: 'manual', text: '原始材料' }] }
}

describe('evidence staged input parsing', () => {
  // 信封阶段只固定请求和授权身份，固定内容约束在收据未命中后建立。
  it('keeps reason and confidence unchanged and checks extra fields only at their owning stage', () => {
    // 同一有效输入先证明正常通过，再分别破坏业务参数与依据字段。
    const params = collectParams(), requestId = randomUUID()
    const parsed = evidenceReadCommand(evidenceReadEnvelope({ method: 'evidence.collect', requestId, params }))
    expect(parsed.params).toEqual(params)
    const extra = evidenceReadEnvelope({ method: 'evidence.collect', requestId, params: { ...params, '': true } })
    expect(() => evidenceReadCommand(extra)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    const basisExtra = evidenceReadEnvelope({ method: 'evidence.collect', requestId,
      params: { ...params, basisRefs: [{ kind: 'manual', text: '原始材料', extra: true }] } })
    expect(() => evidenceReadCommand(basisExtra)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('preserves the specific empty reason error and the UTF-8 byte limit', () => {
    // 字符串类型与内容错误仍为理由专用错误，大体积合法文字保留体积错误。
    for (const reason of ['', '  ', null]) {
      const envelope = evidenceReadEnvelope({ method: 'evidence.collect', requestId: randomUUID(), params: { ...collectParams(), reason } })
      expect(() => evidenceReadCommand(envelope)).toThrow(expect.objectContaining({ code: 'EVIDENCE_REASON_REQUIRED' }))
    }
    const oversized = evidenceReadEnvelope({ method: 'evidence.collect', requestId: randomUUID(), params: { ...collectParams(), reason: '字'.repeat(22_000) } })
    expect(() => evidenceReadCommand(oversized)).toThrow(expect.objectContaining({ status: 413, code: 'EVIDENCE_INPUT_LIMIT' }))
  })

  it.each([{ from: 'invalid', to: '2026-12-31' }, { from: '2026-12-31', to: '2026-01-01' }])('rejects an invalid or reversed range %j', time => {
    // 仅时间范围失效，不能因重复解析减少而接纳 NaN 或反向区间。
    const params = collectParams()
    params.applicability.time = time
    expect(() => evidenceReadCommand(evidenceReadEnvelope({ method: 'evidence.collect', requestId: randomUUID(), params })))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })
})
