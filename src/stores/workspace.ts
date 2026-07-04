import { defineStore } from 'pinia'
import type {
  DisplayNews,
  DisplayNewsSummary,
} from '../../electron/api/types'

function getApi() {
  return typeof window !== 'undefined' ? window.electronAPI : undefined
}

/**
 * 新闻列表与当前文档。图运行态一律走 flow-map store / MapAPI。
 */
export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    newsList: [] as DisplayNewsSummary[],
    currentNewsId: null as string | null,
    currentNews: null as DisplayNews | null,
    loading: false,
  }),

  actions: {
    async loadNewsList() {
      const api = getApi()
      if (!api) return
      this.loading = true
      try {
        this.newsList = await api.news.list()
      } finally {
        this.loading = false
      }
    },

    async selectNews(newsId: string) {
      const api = getApi()
      if (!api) return
      this.currentNewsId = newsId
      this.currentNews = await api.news.get(newsId)
    },

    async refreshCurrentNews() {
      if (!this.currentNewsId) return
      const api = getApi()
      if (!api) return
      this.currentNews = await api.news.get(this.currentNewsId)
    },

    async createNews() {
      const api = getApi()
      if (!api) return
      this.loading = true
      try {
        const news = await api.news.create({
          content: '（请在此粘贴或编辑新闻正文）',
          context: {},
        })
        await this.loadNewsList()
        await this.selectNews(news._id)
      } finally {
        this.loading = false
      }
    },
  },
})
