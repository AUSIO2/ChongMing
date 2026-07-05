import { mapIdCreateNews, mapIdReadChain } from '../ids'
import type { TimelineScheduleSpec } from './types'

export const parseScheduleSpec: TimelineScheduleSpec = {
  key: '0-1',

  readPending(ctx) {
    const items = []
    for (const node of ctx.snapshot.nodes) {
      if (node.kind !== 'source' || node.parentId) continue
      const chainId = mapIdReadChain(node.id)
      if (!chainId) continue
      const newsId = mapIdCreateNews(chainId)
      const news = ctx.snapshot.nodes.find(n => n.id === newsId && n.kind === 'news')
      if (!news || !news.params.content.trim()) {
        items.push({ parentNodeId: node.id })
      }
    }
    return items
  },

  readInterruptStale(ctx, parentId) {
    const chainId = mapIdReadChain(parentId)
    if (!chainId) return false
    const newsId = mapIdCreateNews(chainId)
    const news = ctx.snapshot.nodes.find(n => n.id === newsId && n.kind === 'news')
    return !!news?.params.content.trim()
  },

  readScopePatch(parentId) {
    const chainId = mapIdReadChain(parentId)
    if (!chainId) return undefined
    return { activeScope: mapIdCreateNews(chainId) }
  },
}
