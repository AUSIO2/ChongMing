import { promptFormat } from './prompt-loader'
import type { PromptConfig } from './types'
import { promptAssembleOutput, type PromptOutputParams } from './prompt-output'

export type { PromptOutputParams } from './prompt-output'
export type { ClaimCategory } from './prompt-output'

export type PromptKind =
  | 'splitSubAgent'
  | 'verifySubAgent'
  | 'splitRoute'
  | 'splitMerge'
  | 'verifyRoute'
  | 'verifyMerge'
  | 'parseExtract'

export interface PromptVarSlot {
  id: string
  label: string
  placeholder: string
  description?: string
}

const PROMPT_VAR_SLOTS: Record<PromptKind, PromptVarSlot[]> = {
  splitSubAgent: [
    { id: 'hint', label: '【协调者提示】', placeholder: '{{hint}}', description: 'MainAgent / 槽位 hint' },
    { id: 'context', label: '【上下文】', placeholder: '{{context}}', description: 'AI 可见新闻上下文' },
    { id: 'content', label: '【新闻正文】', placeholder: '{{content}}', description: '当前 scope 新闻正文' },
  ],
  verifySubAgent: [
    { id: 'hint', label: '【协调者提示】', placeholder: '{{hint}}' },
    { id: 'context', label: '【上下文】', placeholder: '{{context}}' },
    { id: 'claimContent', label: '【待核查事实】', placeholder: '{{claimContent}}' },
    { id: 'originalContent', label: '【新闻原文（参照）】', placeholder: '{{originalContent}}' },
  ],
  splitRoute: [
    { id: 'availableAgents', label: '【可用 SubAgent】', placeholder: '{{availableAgents}}' },
    { id: 'context', label: '【上下文】', placeholder: '{{context}}' },
    { id: 'content', label: '【新闻正文】', placeholder: '{{content}}' },
  ],
  verifyRoute: [
    { id: 'availableAgents', label: '【可用 SubAgent】', placeholder: '{{availableAgents}}' },
    { id: 'context', label: '【上下文】', placeholder: '{{context}}' },
    { id: 'claimContent', label: '【待核查事实】', placeholder: '{{claimContent}}' },
    { id: 'originalContent', label: '【新闻原文（参照）】', placeholder: '{{originalContent}}' },
  ],
  splitMerge: [
    { id: 'content', label: '【新闻正文】', placeholder: '{{content}}' },
    { id: 'subResults', label: '【草稿列表（按下标）】', placeholder: '{{subResults}}' },
  ],
  verifyMerge: [
    { id: 'claimContent', label: '【待核查事实】', placeholder: '{{claimContent}}' },
    { id: 'originalContent', label: '【新闻原文（参照）】', placeholder: '{{originalContent}}' },
    { id: 'opinions', label: '【各 SubAgent 意见】', placeholder: '{{opinions}}' },
  ],
  parseExtract: [
    { id: 'rawContent', label: '【原始稿件】', placeholder: '{{rawContent}}' },
  ],
}

export function promptReadSlots(kind: PromptKind): PromptVarSlot[] {
  return PROMPT_VAR_SLOTS[kind].map(s => ({ ...s }))
}

export function promptReadSlotIds(kind: PromptKind): string[] {
  return PROMPT_VAR_SLOTS[kind].map(s => s.id)
}

export function promptAssemble(
  body: string,
  promptVars: string[] | undefined,
  kind: PromptKind,
  outputParams?: PromptOutputParams,
): string {
  const trimmed = body.trim()
  const parts: string[] = [trimmed]

  if (promptVars?.length) {
    const slotById = new Map(PROMPT_VAR_SLOTS[kind].map(s => [s.id, s]))
    const blocks: string[] = []
    for (const id of promptVars) {
      const slot = slotById.get(id)
      if (!slot) continue
      blocks.push(`${slot.label}\n${slot.placeholder}`)
    }
    if (blocks.length > 0) parts.push(blocks.join('\n\n'))
  }

  const output = promptAssembleOutput(kind, outputParams)
  if (output) parts.push(output)

  return parts.filter(Boolean).join('\n\n')
}

export function promptRender(
  body: string,
  promptVars: string[] | undefined,
  kind: PromptKind,
  runtimeVars: Record<string, string>,
  outputParams?: PromptOutputParams,
): string {
  return promptFormat(
    promptAssemble(body, promptVars, kind, outputParams),
    runtimeVars,
  )
}

export function promptReadOutputParams(
  config: Pick<PromptConfig, 'claimCategory'>,
  kind: PromptKind,
): PromptOutputParams | undefined {
  if (kind === 'splitSubAgent') {
    return { claimCategory: config.claimCategory ?? 'data' }
  }
  return undefined
}

export function promptReadKindForSubAgent(module: 'split' | 'verify'): PromptKind {
  return module === 'split' ? 'splitSubAgent' : 'verifySubAgent'
}

export function promptReadKindForPath(promptPath: string): PromptKind | null {
  if (promptPath === 'fact-parser/extract') return 'parseExtract'
  if (promptPath === 'fact-extractor/main-agent-route') return 'splitRoute'
  if (promptPath === 'fact-extractor/main-agent-merge') return 'splitMerge'
  if (promptPath === 'fact-verifier/main-agent-route') return 'verifyRoute'
  if (promptPath === 'fact-verifier/main-agent-merge') return 'verifyMerge'
  if (promptPath.startsWith('fact-extractor/sub-agents/')) return 'splitSubAgent'
  if (promptPath.startsWith('fact-verifier/sub-agents/')) return 'verifySubAgent'
  return null
}
