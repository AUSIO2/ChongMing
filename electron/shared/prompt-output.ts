import type { PromptKind } from './prompt-vars'

export type ClaimCategory = 'data' | 'quote' | 'causal'

export const CLAIM_CATEGORIES: ClaimCategory[] = ['data', 'quote', 'causal']

export interface PromptOutputParams {
  claimCategory?: ClaimCategory
}

const OUTPUT_HEADER = '【返回格式】'

function promptFormatSplitSubAgent(category: string): string {
  return [
    '请仅返回 JSON 数组，不要包含 markdown 或其他说明文字。每条格式：',
    `{"content": "事实陈述", "category": "${category}"}`,
    '',
    '若无相关事实，返回空数组 []。',
  ].join('\n')
}

function promptFormatVerifySubAgent(): string {
  return [
    '评分枚举（必须三选一）：1=可信，0.5=不确定，0=不可信',
    '',
    '请仅返回 JSON 对象，不要包含 markdown 或其他说明文字。格式：',
    '{"score": 0.5, "reason": "核查理由"}',
  ].join('\n')
}

function promptFormatSplitRoute(): string {
  return [
    '请仅返回 JSON 数组，不要包含 markdown 或其他说明文字。每条格式：',
    '{"agentName": "与可用列表完全一致的名称", "priority": "high|medium|low", "hint": "可选提示"}',
    '',
    '示例：',
    '[{"agentName": "数据事实", "priority": "high"}, {"agentName": "引用观点", "priority": "medium"}]',
  ].join('\n')
}

function promptFormatVerifyRoute(): string {
  return [
    '请仅返回 JSON 数组，不要包含 markdown 或其他说明文字。每条格式：',
    '{"agentName": "与可用列表完全一致的名称", "priority": "high|medium|low", "hint": "可选提示"}',
    '',
    '示例：',
    '[{"agentName": "来源可信度", "priority": "high"}, {"agentName": "逻辑一致性", "priority": "medium"}]',
  ].join('\n')
}

function promptFormatSplitMerge(): string {
  return [
    '请仅返回 JSON 数组，长度必须与草稿条数一致，不要包含 markdown 或其他说明文字。每项格式：',
    '{"draftIndex": 0, "shouldSave": true}',
    '',
    '规则：',
    '- draftIndex 从 0 起，与草稿列表一一对应',
    '- 默认 shouldSave 为 true',
    '- 仅当重复、无法从原文支撑、或明显无效时设为 false',
    '- 不要新增条目，不要省略条目',
  ].join('\n')
}

function promptFormatVerifyMerge(): string {
  return [
    '评分枚举（必须三选一）：',
    '- 1：可信',
    '- 0.5：不确定',
    '- 0：不可信',
    '',
    '请仅返回 JSON 对象，不要包含 markdown 或其他说明文字。格式：',
    '{"score": 1, "reason": "汇总理由"}',
  ].join('\n')
}

function promptFormatParseExtract(): string {
  return '只输出正文纯文本，不要 JSON 或 markdown 代码块。'
}

export function promptFormatOutput(
  kind: PromptKind,
  params?: PromptOutputParams,
): string {
  switch (kind) {
    case 'splitSubAgent':
      return promptFormatSplitSubAgent(params?.claimCategory ?? 'data')
    case 'verifySubAgent':
      return promptFormatVerifySubAgent()
    case 'splitRoute':
      return promptFormatSplitRoute()
    case 'verifyRoute':
      return promptFormatVerifyRoute()
    case 'splitMerge':
      return promptFormatSplitMerge()
    case 'verifyMerge':
      return promptFormatVerifyMerge()
    case 'parseExtract':
      return promptFormatParseExtract()
    default:
      return ''
  }
}

export function promptAssembleOutput(
  kind: PromptKind,
  params?: PromptOutputParams,
): string {
  const body = promptFormatOutput(kind, params)
  if (!body) return ''
  return `${OUTPUT_HEADER}\n${body}`
}
