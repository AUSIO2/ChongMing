// 092先行用例：选材只使用当前库摘要，并把精确引用绑定到明确核查步骤。
import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'

import type { ClientGateway, QueryInputMap, QueryOutputMap } from '../../contracts/client'
import type { EvidenceEntrySummary, EvidencePage } from '../../contracts/evidence-library'
import type { GraphRunPlan } from '../../contracts/graph-run'
import { evidenceBindClaimsToStep, evidenceCreateSelection, type EvidenceSelectionContext } from '../../apps/ui/features/evidence-library/evidence-selection'

function item(
  /* 真实接口交付的收录身份。 */ id: string,
  /* 摘要中的固定判断。 */ confidence: 0 | 1 = 0,
): EvidenceEntrySummary {
  // 构造已校验公共网关 seam 的摘要，不生成库业务结果。
  return { id, content: `陈述 ${id}`, contentDigest: `digest-${id}`, confidence, status: 'active' }
}

function fixture() {
  // 使用受控读取 seam 验证前端选择；不实现数据库、核查或使用记账。
  const context = ref<EvidenceSelectionContext>({ userId: 'user', connectionKey: 'service', workspaceId: 'workspace',
    active: false, canEdit: false, targetKey: 'map:transition' })
  const reads: Array<{ params: QueryInputMap['evidence.search']; signal?: AbortSignal;
    resolve: (/* 后端已校验的摘要页。 */ page: EvidencePage) => void }> = []
  const unexpected = async (): Promise<never> => { /* 选材不允许发写命令或其他传输。 */ throw new Error('Unexpected selection operation') }
  const gateway: ClientGateway = { watch: unexpected, getConnection: unexpected, connect: unexpected,
    disconnect: unexpected, dispatch: unexpected, upload: unexpected, download: unexpected,
    async read<K extends keyof QueryInputMap>(
      /* 当前公开读取方法。 */ method: K,
      /* 选材请求的有界筛选。 */ params: QueryInputMap[K],
      /* 窗口拥有的取消信号。 */ signal?: AbortSignal,
    ): Promise<QueryOutputMap[K]> {
      // 只有显式检索进入此 seam，选择不会读取普通 Map 或库全文。
      if (method !== 'evidence.search') return unexpected()
      const value = await new Promise<EvidencePage>((/* 本次页读取的实际完成入口。 */ resolve) => {
        // 泛型参数仅在已确认search分支映射，测试保存原请求不补业务字段。
        reads.push({ params: params as QueryInputMap['evidence.search'], signal, resolve })
      })
      return value as QueryOutputMap[K]
    },
  }
  const derivedContext = computed<EvidenceSelectionContext>(() => /* 与真实步骤组件一致，每次活动卡变化都会重建上下文对象。 */ ({ ...context.value }))
  return { context, reads, selection: evidenceCreateSelection(gateway, derivedContext) }
}

async function settle(): Promise<void> {
  // 排空已完成页读取的微任务，不猜测网络耗时。
  await Promise.resolve()
  await Promise.resolve()
}

describe('explicit library selection', () => {
  it('keeps exact selected refs while its computed step context is inactive and clears only a changed target', async () => {
    // 切卡只暂停候选读取，不把同身份同目标的已有材料清掉；真实换目标仍同步清空。
    const f = fixture()
    try {
      f.context.value.active = true
      f.reads[0].resolve({ items: [item('a')], nextCursor: null, libraryRevision: 1 })
      await settle()
      expect(f.selection.toggle(item('a'))).toBe(true)
      const selected = [{ entryId: 'a', contentDigest: 'digest-a' }]
      f.context.value.active = false
      expect(f.selection.refs.value).toEqual(selected)
      f.context.value.active = true
      expect(f.selection.refs.value).toEqual(selected)
      expect(f.reads).toHaveLength(2)
      f.context.value.targetKey = 'different-step-target'
      expect(f.selection.refs.value).toEqual([])
    } finally { f.selection.dispose() }
  })

  it('does not auto-select evidence and preserves a chosen zero as an exact reference', async () => {
    // 打开表单只加载候选，只有用户toggle才选；0不是未提供。
    const f = fixture()
    f.context.value.active = true
    f.reads[0].resolve({ items: [item('a', 0), item('b', 1)], nextCursor: null, libraryRevision: 2 })
    await settle()
    expect(f.selection.selected.value).toEqual([])
    expect(f.selection.toggle(item('a', 0))).toBe(true)
    expect(f.selection.refs.value).toEqual([{ entryId: 'a', contentDigest: 'digest-a' }])
    expect(f.selection.selected.value[0].confidence).toBe(0)
    expect(f.reads).toHaveLength(1)
    f.selection.dispose()
  })

  it('rejects fabricated and inactive candidates and stops at thirty two selections', async () => {
    // 客户端只选当前已载入的活动摘要，容量不会静默丢掉旧选择。
    const f = fixture()
    const items = Array.from({ length: 33 }, (/* 数组位置占位。 */ _value, /* 合成摘要固定身份位置。 */ index) => /* 构造已加载候选。 */ item(`entry-${index}`))
    f.context.value.active = true
    f.reads[0].resolve({ items, nextCursor: null, libraryRevision: 1 })
    await settle()
    expect(f.selection.toggle(item('fabricated'))).toBe(false)
    expect(f.selection.toggle({ ...items[0], status: 'withdrawn' })).toBe(false)
    for (const candidate of items.slice(0, 32)) expect(f.selection.toggle(candidate)).toBe(true)
    expect(f.selection.toggle(items[32])).toBe(false)
    expect(f.selection.selected.value).toHaveLength(32)
    expect(f.selection.toggle(items[0])).toBe(true)
    expect(f.selection.selected.value).toHaveLength(31)
    f.selection.dispose()
  })

  it.each(['userId', 'connectionKey', 'workspaceId', 'targetKey'] as const)('clears selection when %s changes', async (
    /* 此用例切换的身份或核查目标维度。 */ field,
  ) => {
    const f = fixture()
    f.context.value.active = true
    f.reads[0].resolve({ items: [item('a')], nextCursor: null, libraryRevision: 1 })
    await settle()
    f.selection.toggle(item('a'))
    f.context.value[field] = `other-${field}`
    expect(f.selection.selected.value).toEqual([])
    f.selection.dispose()
  })

  it('cancels candidate reads when the selection dialog closes', () => {
    // 关闭表单只结束候选读取，不能让旧结果打开或填充新表单。
    const f = fixture()
    f.context.value.active = true
    const read = f.reads[0]
    f.context.value.active = false
    expect(read.signal?.aborted).toBe(true)
    f.selection.dispose()
  })

  it('binds exact references to one step without adding source ids to input or context', () => {
    // 步骤选择是只读外部材料，不改变本图分支或节点集合。
    const plan: GraphRunPlan = { steps: ['first', 'second'].map((/* 明确目标步骤身份。 */ id) => /* 构造真实有限步骤形状。 */ ({
      id, transitionRef: { id: 'test.check', version: 1 }, dependsOn: [],
      input: [{ port: 'target', source: { kind: 'scope' as const, nodeIds: ['target-node'] } }], context: [],
      grouping: { mode: 'each' as const }, onEmpty: 'fail' as const,
    })) }
    const refs = [{ entryId: 'library-entry', contentDigest: 'fixed-digest' }]
    const next = { steps: [plan.steps[0], evidenceBindClaimsToStep(plan.steps[1], refs)] }
    expect(next.steps[0].libraryClaimRefs).toBeUndefined()
    expect(next.steps[1].libraryClaimRefs).toEqual(refs)
    expect(next.steps[1].input).toEqual(plan.steps[1].input)
    expect(next.steps[1].context).toEqual([])
    expect(plan.steps[1].libraryClaimRefs).toBeUndefined()
    refs[0].contentDigest = 'changed-draft'
    expect(next.steps[1].libraryClaimRefs?.[0].contentDigest).toBe('fixed-digest')
  })
})
