export interface FlowMapSeedNews {
  newsId: string
  title: string
  content: string
}

/**
 * Map 层手动验收用种子新闻。
 * 正文同时含数据 / 引语 / 时间线要素，便于观察 Route 预置的三类拆分槽。
 */
export const FLOW_MAP_SEED: FlowMapSeedNews[] = [
  {
    newsId: 'map-demo-1',
    title: 'A 公司第二代产品发布会',
    content:
      '2026 年 7 月 1 日，A 公司在上海国际会议中心举行第二代旗舰产品发布会。' +
      'CEO 王明在主题演讲中表示：「我们要在两年内进入行业前三，售价较上一代下调 12%。」' +
      '公司宣布首年销量目标为 500 万台，并计划于 2026 年 8 月 30 日完成首批出货。' +
      '首席工程师李华会后接受采访称，性能提升主要来自新一代自研芯片，该芯片已于 2026 年 6 月 15 日通过内部认证。' +
      '发改委相关人士回应媒体时称，对本土芯片产业链持支持态度，但未就具体补贴金额表态。',
  },
]

export function flowMapSeedToInstallElectronOptions() {
  return FLOW_MAP_SEED.map(s => ({
    _id: s.newsId,
    content: s.content,
  }))
}
