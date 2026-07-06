import type { ClaimCategory } from './prompt-output'
import type { PromptKind } from './prompt-vars'
import { promptReadSlotIds } from './prompt-vars'

const INJECTION_BLOCK_RE = /【[^】]+】\s*\n\{\{(\w+)\}\}/g
const CLAIM_CATEGORY_RE = /"category":\s*"(\w+)"/

const OUTPUT_MARKERS = [
  /请仅返回 JSON 数组[\s\S]*/i,
  /请仅返回 JSON 对象[\s\S]*/i,
  /评分枚举（必须三选一）[\s\S]*/i,
  /只输出正文纯文本[\s\S]*/i,
  /若无[^。\n]*事实[^。\n]*，返回空数组 \[\]\.?/i,
]

export interface PromptMigrateResult {
  content: string
  promptVars: string[]
  claimCategory?: ClaimCategory
}

function promptStripOutputFormat(content: string): string {
  let next = content
  for (const re of OUTPUT_MARKERS) {
    next = next.replace(re, '')
  }
  return next.replace(/\n{3,}/g, '\n\n').trim()
}

function promptReadClaimCategory(raw: string): ClaimCategory | undefined {
  const match = raw.match(CLAIM_CATEGORY_RE)
  const value = match?.[1]
  if (value === 'data' || value === 'quote' || value === 'causal') return value
  return undefined
}

/** 从旧版整段 content 剥离注入块与返回格式，推断 promptVars / claimCategory。 */
export function promptMigrateContent(
  raw: string,
  kind: PromptKind,
): PromptMigrateResult {
  const allowed = new Set(promptReadSlotIds(kind))
  const promptVars: string[] = []
  const seen = new Set<string>()

  let content = raw
  const matches = [...raw.matchAll(INJECTION_BLOCK_RE)]
  for (const match of matches) {
    const varId = match[1]
    if (!allowed.has(varId) || seen.has(varId)) continue
    seen.add(varId)
    promptVars.push(varId)
    content = content.replace(match[0], '')
  }

  const claimCategory = kind === 'splitSubAgent'
    ? promptReadClaimCategory(raw)
    : undefined

  content = promptStripOutputFormat(content)

  return {
    content,
    promptVars,
    claimCategory,
  }
}
