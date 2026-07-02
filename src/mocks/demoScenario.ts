import type { NewsContext, RouteInstruction } from '../../electron/api/types'

/** 演示案例：地方地铁新线开通报道 — 含数据、引语、因果与待核实传闻 */

export const DEMO_SCENARIO_TITLE = '某市地铁4号线开通'

export const DEMO_NEWS_CONTENT =
  '3月15日，某市地铁4号线一期工程正式开通运营。市交通委通报，试运营首周客流量达128万人次，'
  + '日均18.3万人次。市长在开通仪式上表示，4号线将串联北部科技城与市中心商务区，'
  + '方便沿线约50万居民出行。交通专家指出，新线开通后，市中心至科技城通行时间'
  + '将由约75分钟缩短至28分钟。'
  + '另有网络传言称「4号线单程票价将涨至10元」，市发改委相关负责人已在记者会上予以否认。'

export function demoNewsContext(): NewsContext {
  return {
    headline: { value: DEMO_SCENARIO_TITLE, visibleToAI: true },
    source: { value: '江海晚报', visibleToAI: true },
    date: { value: '2026-03-15', visibleToAI: true },
    region: { value: '江东市', visibleToAI: true },
    section: { value: '民生', visibleToAI: true },
  }
}

export const DEMO_VISIBLE_CONTEXT = {
  headline: DEMO_SCENARIO_TITLE,
  source: '江海晚报',
  date: '2026-03-15',
  region: '江东市',
  section: '民生',
}

export const DEMO_DEFAULT_ROUTES: RouteInstruction[] = [
  { agentName: '数据事实', priority: 'high', hint: '关注客流量与通行时长' },
  { agentName: '引用观点', priority: 'medium', hint: '市长与发改委表态' },
  { agentName: '因果关系', priority: 'low', hint: '新线对通勤时间的影响' },
]

export const DEMO_SUB_AGENT_RESULTS = [
  {
    agentName: '数据事实',
    priority: 'high' as const,
    claims: [
      {
        content: '试运营首周客流量达128万人次，日均18.3万人次。',
        category: 'data',
        sourceAgent: '数据事实',
      },
      {
        content: '市中心至科技城通行时间将由约75分钟缩短至28分钟。',
        category: 'data',
        sourceAgent: '数据事实',
      },
    ],
    rawResponse: '[]',
  },
  {
    agentName: '引用观点',
    priority: 'medium' as const,
    claims: [
      {
        content: '市长表示，4号线将串联北部科技城与市中心商务区，方便沿线约50万居民出行。',
        category: 'quote',
        sourceAgent: '引用观点',
      },
      {
        content: '市发改委相关负责人否认「4号线单程票价将涨至10元」的网络传言。',
        category: 'quote',
        sourceAgent: '引用观点',
      },
    ],
    rawResponse: '[]',
  },
  {
    agentName: '因果关系',
    priority: 'low' as const,
    claims: [
      {
        content: '4号线开通后，科技城与市中心之间的通勤时间显著缩短。',
        category: 'causal',
        sourceAgent: '因果关系',
      },
    ],
    rawResponse: '[]',
  },
]

export const DEMO_MERGED_CLAIMS = [
  {
    content: '试运营首周客流量达128万人次，日均18.3万人次。',
    category: 'data',
    sourceAgent: '数据事实',
  },
  {
    content: '市长表示，4号线将串联北部科技城与市中心商务区，方便沿线约50万居民出行。',
    category: 'quote',
    sourceAgent: '引用观点',
  },
  {
    content: '市中心至科技城通行时间将由约75分钟缩短至28分钟。',
    category: 'data',
    sourceAgent: '数据事实',
  },
  {
    content: '4号线开通后，科技城与市中心之间的通勤时间显著缩短。',
    category: 'causal',
    sourceAgent: '因果关系',
  },
  {
    content: '网传「4号线单程票价将涨至10元」已被市发改委否认，但仍需关注后续官方票价公告。',
    category: 'other',
    sourceAgent: 'merge',
  },
]

export const DEMO_VERIFY_ROUTES: RouteInstruction[] = [
  { agentName: '来源可信度', priority: 'high' },
  { agentName: '数据可验证性', priority: 'high' },
  { agentName: '逻辑一致性', priority: 'medium' },
]

export function demoVerifyOpinions(claimContent: string) {
  const isPassengerClaim = claimContent.includes('128万') || claimContent.includes('18.3万')
  const isQuoteClaim = claimContent.includes('市长')
  const isRumorClaim = claimContent.includes('票价') || claimContent.includes('否认')

  if (isPassengerClaim) {
    return {
      routeInstructions: [
        { agentName: '来源可信度', priority: 'high' as const },
        { agentName: '数据可验证性', priority: 'high' as const },
      ],
      subAgentOpinions: [
        {
          agentName: '来源可信度',
          priority: 'high' as const,
          score: 1 as const,
          reason: '数据来自市交通委正式通报，江海晚报全文转载，来源链条清晰。',
          rawResponse: '{}',
        },
        {
          agentName: '数据可验证性',
          priority: 'high' as const,
          score: 0.5 as const,
          reason: '首周客流为试运营口径，需对照交通委后续月度公报复核。',
          rawResponse: '{}',
        },
      ],
      finalScore: 0.5 as const,
      finalReason: '官方来源可信，但试运营首周数据仍建议等待更长期统计后再下结论。',
    }
  }

  if (isQuoteClaim) {
    return {
      routeInstructions: [{ agentName: '逻辑一致性', priority: 'high' as const }],
      subAgentOpinions: [
        {
          agentName: '逻辑一致性',
          priority: 'high' as const,
          score: 1 as const,
          reason: '市长表态与报道中串联科技城、商务区及居民规模的表述一致，未见断章取义。',
          rawResponse: '{}',
        },
      ],
      finalScore: 1 as const,
      finalReason: '引语与原文语境一致，可采信。',
    }
  }

  if (isRumorClaim) {
    return {
      routeInstructions: [
        { agentName: '来源可信度', priority: 'high' as const },
        { agentName: '逻辑一致性', priority: 'medium' as const },
      ],
      subAgentOpinions: [
        {
          agentName: '来源可信度',
          priority: 'high' as const,
          score: 0.5 as const,
          reason: '否认表态有报道出处，但网传截图本身未纳入核查材料。',
          rawResponse: '{}',
        },
        {
          agentName: '逻辑一致性',
          priority: 'medium' as const,
          score: 0.5 as const,
          reason: '否认传言不等于票价政策终稿，结论宜保留不确定性。',
          rawResponse: '{}',
        },
      ],
      finalScore: 0.5 as const,
      finalReason: '官方已否认涨价传言，但票价最终以发改委公告为准。',
    }
  }

  return {
    routeInstructions: DEMO_VERIFY_ROUTES,
    subAgentOpinions: [
      {
        agentName: '来源可信度',
        priority: 'high' as const,
        score: 0.5 as const,
        reason: '报道来源为地方晚报，建议交叉比对政府官网。',
        rawResponse: '{}',
      },
    ],
    finalScore: 0.5 as const,
    finalReason: '信息有限，暂列为不确定。',
  }
}
