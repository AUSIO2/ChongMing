import { defineStore } from 'pinia'
import type {
  ExecutionMode,
  GraphCompletedPayload,
  GraphErrorPayload,
  GraphInterruptNode,
  GraphInterruptedPayload,
  GraphStatePatch,
  GraphType,
  NewsDocumentDTO,
  NewsDocumentSummaryDTO,
  SplitGraphStateDTO,
  VerifyGraphStateDTO,
} from '../../electron/api/types'

export type GraphStatus = 'idle' | 'running' | 'interrupted' | 'completed' | 'error'
export type ViewMode = 'workspace' | 'flow'

function getApi() {
  return window.electronAPI
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    newsList: [] as NewsDocumentSummaryDTO[],
    currentNewsId: null as string | null,
    currentNews: null as NewsDocumentDTO | null,
    selectedClaimId: null as string | null,
    executionMode: 'human-in-loop' as ExecutionMode,
    viewMode: 'workspace' as ViewMode,
    runId: null as string | null,
    graphType: null as GraphType | null,
    graphStatus: 'idle' as GraphStatus,
    nextNode: null as GraphInterruptNode | null,
    graphState: null as SplitGraphStateDTO | VerifyGraphStateDTO | null,
    graphError: null as string | null,
    loading: false,
    eventCleanups: [] as Array<() => void>,
  }),

  getters: {
    isRunning: state => state.graphStatus === 'running',
    isInterrupted: state => state.graphStatus === 'interrupted',
    selectedClaim: (state) => {
      if (!state.currentNews || !state.selectedClaimId) return null
      return state.currentNews.claims.find(c => c.claimId === state.selectedClaimId) ?? null
    },
  },

  actions: {
    initGraphEvents() {
      const api = getApi()
      if (!api) return

      this.eventCleanups.forEach(fn => fn())
      this.eventCleanups = [
        api.events.onInterrupted(payload => this.handleInterrupted(payload)),
        api.events.onCompleted(payload => this.handleCompleted(payload)),
        api.events.onError(payload => this.handleError(payload)),
      ]
    },

    disposeGraphEvents() {
      this.eventCleanups.forEach(fn => fn())
      this.eventCleanups = []
    },

    async loadNewsList() {
      const api = getApi()
      if (!api) return
      this.newsList = await api.news.list()
    },

    async selectNews(newsId: string) {
      const api = getApi()
      if (!api) return
      this.currentNewsId = newsId
      this.selectedClaimId = null
      this.currentNews = await api.news.get(newsId)
      if (this.currentNews?.claims.length) {
        this.selectedClaimId = this.currentNews.claims[0].claimId
      }
    },

    async refreshCurrentNews() {
      if (!this.currentNewsId) return
      await this.selectNews(this.currentNewsId)
    },

    async createSampleNews() {
      const api = getApi()
      if (!api) return
      this.loading = true
      try {
        const news = await api.news.create({
          content:
            '2026年6月30日，某市统计局发布数据显示，全市上半年GDP增长5.2%。'
            + '市长在新闻发布会上表示，将继续推进数字化转型。'
            + '专家指出，这一增速高于全国平均水平。',
          context: {
            source: { value: '示例日报', visibleToAI: true },
            date: { value: '2026-06-30', visibleToAI: true },
            region: { value: '某市', visibleToAI: true },
          },
        })
        await this.loadNewsList()
        await this.selectNews(news._id)
      } finally {
        this.loading = false
      }
    },

    async startSplit() {
      if (!this.currentNewsId) return
      const api = getApi()
      if (!api) return
      this.graphStatus = 'running'
      this.graphError = null
      const { runId } = await api.graph.startSplit({
        newsId: this.currentNewsId,
        mode: this.executionMode,
      })
      this.runId = runId
      this.graphType = 'split'
    },

    async startVerify() {
      if (!this.currentNewsId || !this.selectedClaimId) return
      const api = getApi()
      if (!api) return
      this.graphStatus = 'running'
      this.graphError = null
      const { runId } = await api.graph.startVerify({
        newsId: this.currentNewsId,
        claimId: this.selectedClaimId,
        mode: this.executionMode,
      })
      this.runId = runId
      this.graphType = 'verify'
    },

    async setExecutionMode(mode: ExecutionMode) {
      this.executionMode = mode
      if (this.runId) {
        await getApi()?.graph.setMode(this.runId, mode)
      }
    },

    async resume(modifications: GraphStatePatch) {
      if (!this.runId) return
      // IPC structured clone 无法传输 Vue reactive Proxy
      const plain = modifications === null
        ? null
        : JSON.parse(JSON.stringify(modifications)) as GraphStatePatch
      await getApi()?.graph.resume(this.runId, plain)
      this.graphStatus = 'running'
      this.nextNode = null
    },

    async cancelRun() {
      if (!this.runId) return
      await getApi()?.graph.cancel(this.runId)
      this.resetGraph()
    },

    resetGraph() {
      this.runId = null
      this.graphType = null
      this.graphStatus = 'idle'
      this.nextNode = null
      this.graphState = null
      this.graphError = null
    },

    async handleInterrupted(payload: GraphInterruptedPayload) {
      this.runId = payload.runId
      this.graphType = payload.graphType
      this.graphStatus = 'interrupted'
      this.nextNode = payload.nextNode
      this.graphState = JSON.parse(JSON.stringify(payload.state)) as typeof payload.state

      if (this.executionMode === 'auto') {
        await this.resume(null)
      }
    },

    async handleCompleted(payload: GraphCompletedPayload) {
      this.graphStatus = 'completed'
      this.graphState = JSON.parse(JSON.stringify(payload.state)) as typeof payload.state
      this.nextNode = null
      await Promise.all([this.refreshCurrentNews(), this.loadNewsList()])
    },

    handleError(payload: GraphErrorPayload) {
      this.graphStatus = 'error'
      this.graphError = payload.error
    },
  },
})
