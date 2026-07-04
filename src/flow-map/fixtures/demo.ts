import type { ClaimParams, OpinionParams, Priority, SubAgentEntry } from '../types'

const PRIORITIES: Priority[] = ['high', 'medium', 'low']

export function buildSplitSubAgentCatalog(): SubAgentEntry[] {
  return [
    {
      agentName: 'fact-splitter',
      displayLabel: '事实拆分',
      description: '把新闻正文拆成可独立核查的事实陈述。',
      defaultPriority: 'high',
    },
    {
      agentName: 'quote-extractor',
      displayLabel: '引语拆分',
      description: '抽取直接引语并归类到当事人。',
      defaultPriority: 'medium',
    },
    {
      agentName: 'timeline-extractor',
      displayLabel: '时间线拆分',
      description: '将新闻中的事件按时间轴排列。',
      defaultPriority: 'low',
    },
  ]
}

export function buildVerifySubAgentCatalog(): SubAgentEntry[] {
  return [
    {
      agentName: 'source-check',
      displayLabel: '来源核查',
      description: '核对报道来源与原始出处是否一致。',
      defaultPriority: 'high',
    },
    {
      agentName: 'logic-check',
      displayLabel: '逻辑核查',
      description: '检查事实内部逻辑是否自洽。',
      defaultPriority: 'medium',
    },
    {
      agentName: 'cross-ref',
      displayLabel: '交叉比对',
      description: '与其他公开报道进行事实比对。',
      defaultPriority: 'low',
    },
  ]
}

export function demoClaimForSubAgent(
  agentName: string,
  index: number,
): ClaimParams {
  const seeds: Record<string, string[]> = {
    'fact-splitter': [
      '2026 年 7 月 1 日，A 公司发布了第二代产品。',
      '发布会上宣布首年销量目标为 500 万台。',
      'CEO 承诺售价较上一代下调 12%。',
    ],
    'quote-extractor': [
      'CEO 表示："我们要在两年内进入前三。"',
      '首席工程师称："性能提升来自新一代芯片。"',
    ],
    'timeline-extractor': [
      '2026-06-15 内部工程样机通过认证。',
      '2026-07-01 举办公开发布会。',
      '2026-08-30 预计首批出货。',
    ],
  }
  const content = seeds[agentName]?.[index] ?? `示例事实 #${index + 1}（来自 ${agentName}）`
  return { content, category: '事实', sourceAgent: agentName }
}

export function demoOpinionForClaim(
  agentName: string,
  claimIndex: number,
  opinionIndex: number,
  priority: Priority = 'medium',
): OpinionParams {
  const content = `[${agentName}] 事实#${claimIndex + 1} 核查意见 #${opinionIndex + 1}`
  return { content, confidence: 1, priority, evidence: '示例证据链接' }
}

export function catalogDefaultPriority(entry: SubAgentEntry, index = 0): Priority {
  return entry.defaultPriority ?? PRIORITIES[Math.min(index, 2)]
}
