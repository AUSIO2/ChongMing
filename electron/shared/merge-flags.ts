/**
 * merge 节点 shouldSave 标记 — extractor merge 与 Map 投影共用。
 */
import { llmReadJson } from './llm-utils'

export interface MergeShouldSaveFlag {
  draftIndex?: number
  shouldSave?: boolean
}

export function mergeReadShouldSave(raw: string): MergeShouldSaveFlag[] {
  const parsed = llmReadJson<unknown>(raw)
  const candidates = Array.isArray(parsed) ? parsed : []
  return candidates.filter(
    (item): item is MergeShouldSaveFlag =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  )
}

/** 将 merge LLM 标记应用到等长草稿列表。 */
export function mergeUpdateClaims<T extends { shouldSave?: boolean }>(
  drafts: T[],
  flags: MergeShouldSaveFlag[],
): T[] {
  const byIndex = new Map<number, boolean>()
  flags.forEach((f, i) => {
    const idx = typeof f.draftIndex === 'number' ? f.draftIndex : i
    byIndex.set(idx, f.shouldSave !== false)
  })
  return drafts.map((draft, i) => ({
    ...draft,
    shouldSave: byIndex.has(i) ? byIndex.get(i)! : true,
  }))
}

/** 将 mergedClaims 的 shouldSave 写回 draft 节点（graph-doc 投影）。 */
export function mergeUpdateDraftFlags(
  drafts: Array<{ shouldSave: boolean }>,
  mergedClaims: Array<{ shouldSave?: boolean; draftIndex?: number }>,
): void {
  if (drafts.length === 0 || !mergedClaims.length) return

  if (mergedClaims.length === drafts.length) {
    drafts.forEach((d, i) => {
      d.shouldSave = mergedClaims[i].shouldSave !== false
    })
    return
  }

  for (const c of mergedClaims) {
    const idx = c.draftIndex
    if (typeof idx === 'number' && drafts[idx]) {
      drafts[idx].shouldSave = c.shouldSave !== false
    }
  }
}
