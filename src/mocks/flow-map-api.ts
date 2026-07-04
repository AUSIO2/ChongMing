import { createLangGraphMockAdapter } from '../flow-map'
import type { MapAPI } from '../flow-map'
import { FLOW_MAP_SEED } from './flow-map-seed'

export function createMockMapAPI(): MapAPI {
  return createLangGraphMockAdapter({
    seedNews: FLOW_MAP_SEED.map(s => ({
      newsId: s.newsId,
      title: s.title,
      content: s.content,
    })),
    // 未知 newsId（用户后续手动创建的新闻）走 electron mock 拉正文
    resolveNews: async (newsId) => {
      if (typeof window === 'undefined' || !window.electronAPI) return null
      const doc = await window.electronAPI.news.get(newsId)
      if (!doc) return null
      return { content: doc.content }
    },
  })
}
