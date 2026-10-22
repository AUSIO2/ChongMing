// 仅构造确定输入和引用，不计算待测实现的业务结果。
import { randomUUID } from 'node:crypto'
import type { Applicability, ClaimRef, CollectInput, Entry, EvidenceTestTarget, LibraryRef, SeedPlan } from './test-contract'
import { HarnessMessage } from './test-contract'

export const PRESSURE_QUERY = 'pressurehit'

export function seedItem(
  /* 合成语料中从零开始的固定位置。 */ index: number,
  /* 场景的固定种子、条目数和正文大小。 */ plan: SeedPlan,
): { content: string; confidence: 0 | 1; matchesQuery: boolean } {
  // 只生成输入语料；匹配预期来自这个标记，不从被测搜索结果反推。
  if (!Number.isInteger(index) || index < 0 || index >= plan.entries || plan.textBytes < 128) {
    throw new Error(HarnessMessage.OPTION_INVALID)
  }
  const hitEvery = plan.hitEvery ?? 5
  if (!Number.isInteger(hitEvery) || hitEvery < 1) throw new Error(HarnessMessage.OPTION_INVALID)
  const matchesQuery = index % hitEvery === 0
  const prefix = `合成档案 ${plan.seed} 的第 ${index} 条陈述。 ${matchesQuery ? PRESSURE_QUERY : 'ordinary'} `
  return { content: prefix + 'x'.repeat(Math.max(0, plan.textBytes - Buffer.byteLength(prefix))),
    confidence: index % 2 === 0 ? 0 : 1, matchesQuery }
}

export function immutableFields(
  /* 真实收录结果中的已知固定字段。 */ entry: Entry,
): Pick<Entry, 'id' | 'workspaceId' | 'claim' | 'confidence' | 'applicability' | 'decision' | 'collectedBy' | 'collectedAt' | 'contentDigest'> {
  // 仅选取待验的固定内容，允许管理状态和来源当前状态另行显示。
  return structuredClone({ id: entry.id, workspaceId: entry.workspaceId, claim: entry.claim,
    confidence: entry.confidence, applicability: entry.applicability, decision: entry.decision,
    collectedBy: entry.collectedBy, collectedAt: entry.collectedAt, contentDigest: entry.contentDigest })
}

export function applicability(
  /* 当前用例明确设置的适用范围差异。 */ changes: Partial<Applicability> = {},
): Applicability {
  // 每次返回新对象，避免不同用例共享可变输入。
  return {
    subject: '澄川公交', event: '线路试点', place: '澄川',
    time: { from: '2026-10-01T00:00:00+08:00', to: '2026-10-31T23:59:59+08:00' },
    conditions: ['本次试点'], ...changes,
  }
}

export function collectInput(
  /* 提供隔离工作区身份的真实测试目标。 */ target: EvidenceTestTarget,
  /* 已在真实目标创建的来源 Claim 版本。 */ claim: ClaimRef,
  /* 用例显式给出的外部置信度输入，允许构造无效值。 */ confidence: unknown,
  /* 本次用例对请求字段的明确覆盖。 */ changes: Partial<CollectInput> = {},
): CollectInput {
  // 生成可追踪的测试请求；置信度不使用默认值。
  return {
    workspaceId: target.workspaceId, requestId: randomUUID(), claim, confidence,
    applicability: applicability(), reason: '测试档案明确记录了本次试点的线路数量。',
    basisRefs: [{ kind: 'manual', text: '隔离测试档案；只用于测试输入。' }], ...changes,
  }
}

export function libraryRef(
  /* 真实实现返回的已收录条目。 */ entry: Entry,
): LibraryRef {
  // 只转发条目身份和实际摘要，不在夹具中重新实现摘要规则。
  return { entryId: entry.id, contentDigest: entry.contentDigest }
}
