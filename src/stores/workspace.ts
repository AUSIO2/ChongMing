import { defineStore } from 'pinia'
import type {
  ExecutionMode,
  GraphCompletedPayload,
  GraphErrorPayload,
  GraphInterruptNode,
  GraphInterruptedPayload,
  GraphProgressPayload,
  GraphStatePatch,
  GraphType,
  NewsDocumentDTO,
  NewsDocumentSummaryDTO,
  RouteInstruction,
  SplitGraphStateDTO,
  VerifyGraphStateDTO,
} from '../../electron/api/types'
import { createInitialFlowNodes } from '../composables/useFlowTopology'
import { resolveFlowNode } from '../composables/useFlowClaimNodes'
import { DEMO_NEWS_CONTENT, demoNewsContext } from '../mocks/demoScenario'
import type { FlowNodePhase, FlowNodeVM, FlowPhase, PipelineStatus } from '../types/flow'
import type { RawClaimDTO } from '../../electron/api/types'
import { subAgentNodeId } from '../utils/routeNodeId'

export type GraphStatus = 'idle' | 'running' | 'interrupted' | 'completed' | 'error'

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
    runId: null as string | null,
    graphType: null as GraphType | null,
    graphStatus: 'idle' as GraphStatus,
    nextNode: null as GraphInterruptNode | null,
    graphState: null as SplitGraphStateDTO | VerifyGraphStateDTO | null,
    graphError: null as string | null,
    loading: false,
    eventCleanups: [] as Array<() => void>,
    flowNodes: [] as FlowNodeVM[],
    selectedFlowNodeId: null as string | null,
    pipelineStatus: 'idle' as PipelineStatus,
    claimsToVerify: [] as string[],
    activeClaimId: null as string | null,
    verifyQueueIndex: 0,
    /** 合并+保存统一步：待写入的事实草稿（驱动拓扑虚线/预览） */
    commitMergedClaims: null as RawClaimDTO[] | null,
    /** 合并步继续后，自动带入保存步的 patch */
    pendingCommitPatch: null as GraphStatePatch | undefined,
  }),

  getters: {
    isRunning: state => state.graphStatus === 'running',
    isInterrupted: state => state.graphStatus === 'interrupted',
    isSelectingClaims: state => state.pipelineStatus === 'selectClaims',
    isSplitCommitStep: (state) => {
      return state.graphStatus === 'interrupted'
        && state.graphType === 'split'
        && (state.nextNode === 'merge' || state.nextNode === 'save')
    },
    isVerifyCommitStep: (state) => {
      return state.graphStatus === 'interrupted'
        && state.graphType === 'verify'
        && (state.nextNode === 'merge' || state.nextNode === 'save')
    },
    selectedFlowNode: (state) => {
      return resolveFlowNode(
        state.selectedFlowNodeId,
        state.graphType,
        state.flowNodes,
        state.graphState,
        {
          news: state.currentNews,
          pipelineStatus: state.pipelineStatus,
          activeClaimId: state.activeClaimId,
          claimsToVerify: state.claimsToVerify,
          commitMergedClaims: state.commitMergedClaims,
          isSplitCommitStep: state.graphStatus === 'interrupted'
            && state.graphType === 'split'
            && (state.nextNode === 'merge' || state.nextNode === 'save'),
        },
      )
    },
    selectedClaim: (state) => {
      if (!state.currentNews || !state.selectedClaimId) return null
      return state.currentNews.claims.find(c => c.claimId === state.selectedClaimId) ?? null
    },
    flowPhase: (state): FlowPhase => {
      if (state.pipelineStatus === 'selectClaims') return 'selectClaims'
      if (state.pipelineStatus === 'error' || state.graphStatus === 'error') return 'error'
      if (state.graphStatus === 'running') return 'running'
      if (state.graphStatus === 'interrupted') {
        if (state.graphType === 'split' && state.nextNode === 'subAgent') return 'awaitingSplit'
        if (state.graphType === 'split' && (state.nextNode === 'merge' || state.nextNode === 'save')) {
          return 'awaitingSplitCommit'
        }
        if (state.graphType === 'verify' && state.nextNode === 'subAgent') return 'awaitingVerifyRoute'
        if (state.graphType === 'verify' && (state.nextNode === 'merge' || state.nextNode === 'save')) {
          return 'awaitingVerifyCommit'
        }
      }
      return 'idle'
    },
    isRouteConfigPhase: (state) => {
      return state.graphStatus === 'interrupted'
        && state.nextNode === 'subAgent'
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
        api.events.onProgress(payload => this.handleProgress(payload)),
      ]
    },

    disposeGraphEvents() {
      this.eventCleanups.forEach(fn => fn())
      this.eventCleanups = []
    },

    initFlow(graphType: GraphType) {
      this.flowNodes = createInitialFlowNodes(graphType)
      this.selectedFlowNodeId = null
    },

    resetFlow() {
      this.flowNodes = []
      this.selectedFlowNodeId = null
    },

    selectFlowNode(nodeId: string | null) {
      this.selectedFlowNodeId = nodeId
      if (nodeId?.startsWith('bridge:claim:')) {
        this.selectedClaimId = nodeId.replace('bridge:claim:', '')
      }
    },

    addRouteInstruction(draft?: Partial<RouteInstruction>) {
      if (!this.isRouteConfigPhase || !this.graphState) return
      const entry: RouteInstruction = {
        agentName: draft?.agentName?.trim() ?? '',
        priority: draft?.priority ?? 'medium',
        hint: draft?.hint ?? '',
      }
      const routes = [...this.graphState.routeInstructions, entry]
      this.syncRouteInstructions(routes)
      this.selectedFlowNodeId = null
    },

    syncRouteInstructions(routes: RouteInstruction[]) {
      if (!this.graphState) return
      const next = {
        ...this.graphState,
        routeInstructions: routes.map(r => ({ ...r })),
      }
      this.graphState = next
      if (this.isRouteConfigPhase) {
        this.buildFanOutFromState(next)
      }
    },

    toggleClaimToVerify(claimId: string) {
      const idx = this.claimsToVerify.indexOf(claimId)
      if (idx >= 0) {
        this.claimsToVerify.splice(idx, 1)
      } else {
        this.claimsToVerify.push(claimId)
      }
    },

    async confirmClaimSelection() {
      if (!this.claimsToVerify.length) return
      this.pipelineStatus = 'running'
      this.verifyQueueIndex = 0
      await this.runNextVerify()
    },

    handleProgress(payload: GraphProgressPayload) {
      if (payload.runId !== this.runId) return

      const reveal = (id: string, phase: FlowNodePhase = 'entering') => {
        const node = this.flowNodes.find(n => n.id === id || n.kind === id)
        if (node && node.phase === 'hidden') {
          node.phase = phase
          setTimeout(() => {
            if (node.phase === 'entering') node.phase = 'active'
          }, 350)
        }
      }

      if (payload.event === 'node_enter') {
        const node = this.flowNodes.find(n => n.id === payload.node || n.kind === payload.node)
        if (node) {
          if (node.phase === 'hidden') {
            reveal(payload.node, 'active')
          } else {
            node.phase = 'active'
          }
        }
      } else if (payload.event === 'node_exit') {
        const node = this.flowNodes.find(n => n.id === payload.node || n.kind === payload.node)
        if (node) {
          if (node.phase === 'hidden') {
            node.phase = 'entering'
            setTimeout(() => { node.phase = 'done' }, 80)
          } else {
            node.phase = 'done'
          }
        }
        if (payload.node === 'subAgent') {
          this.flowNodes.filter(n => n.kind === 'subAgent').forEach((n) => { n.phase = 'done' })
        }
      } else if (payload.event === 'fanout_spawn' && payload.agentName != null) {
        const routeIndex = payload.spawnIndex ?? 0
        const id = subAgentNodeId(routeIndex)
        const delay = routeIndex * 120
        const stage = this.graphType === 'verify' ? 'verify' : 'split'
        setTimeout(() => {
          const existing = this.flowNodes.find(n => n.id === id)
          if (existing) {
            existing.agentName = payload.agentName
            existing.label = payload.agentName!
            existing.spawnIndex = routeIndex
            return
          }
          this.flowNodes.push({
            id,
            nodeCategory: 'agent',
            kind: 'subAgent',
            label: payload.agentName!,
            stage,
            agentRole: 'worker',
            agentName: payload.agentName,
            claimId: this.activeClaimId ?? undefined,
            spawnIndex: routeIndex,
            phase: 'entering',
          })
          setTimeout(() => {
            const node = this.flowNodes.find(n => n.id === id)
            if (node?.phase === 'entering') node.phase = 'active'
          }, 350)
        }, delay)
      }
    },

    syncFlowPaused(nextNode: GraphInterruptNode) {
      for (const node of this.flowNodes) {
        if (node.phase === 'active') node.phase = 'done'
      }
      if (nextNode === 'subAgent') {
        this.flowNodes
          .filter(n => n.kind === 'subAgent' && n.phase !== 'hidden')
          .forEach(n => { n.phase = 'paused' })
      } else {
        const node = this.flowNodes.find(n => n.kind === nextNode)
        if (node) {
          if (node.phase === 'hidden') node.phase = 'paused'
          else node.phase = 'paused'
        }
      }
    },

    buildFanOutFromState(state: SplitGraphStateDTO | VerifyGraphStateDTO) {
      const stage = this.graphType === 'verify' ? 'verify' : 'split'
      this.flowNodes = this.flowNodes.filter(
        n => !(n.kind === 'subAgent' && n.agentRole === 'worker'),
      )
      state.routeInstructions.forEach((instruction, index) => {
        this.flowNodes.push({
          id: subAgentNodeId(index),
          nodeCategory: 'agent',
          kind: 'subAgent',
          label: instruction.agentName,
          stage,
          agentRole: 'worker',
          agentName: instruction.agentName,
          claimId: this.activeClaimId ?? undefined,
          spawnIndex: index,
          phase: this.isRouteConfigPhase ? 'paused' : 'entering',
        })
      })
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
      if (this.pipelineStatus === 'idle') {
        this.resetGraph()
      }
    },

    async refreshCurrentNews() {
      if (!this.currentNewsId) return
      const api = getApi()
      if (!api) return
      this.currentNews = await api.news.get(this.currentNewsId)
    },

    async createSampleNews() {
      const api = getApi()
      if (!api) return
      this.loading = true
      try {
        const news = await api.news.create({
          content: DEMO_NEWS_CONTENT,
          context: demoNewsContext(),
        })
        await this.loadNewsList()
        await this.selectNews(news._id)
      } finally {
        this.loading = false
      }
    },

    async runPipeline() {
      if (!this.currentNewsId) return
      this.pipelineStatus = 'running'
      this.claimsToVerify = []
      this.activeClaimId = null
      this.verifyQueueIndex = 0
      this.graphError = null
      await this.startSplit()
    },

    async startSplit() {
      if (!this.currentNewsId) return
      const api = getApi()
      if (!api) return
      this.graphStatus = 'running'
      this.graphError = null
      this.graphType = 'split'
      this.initFlow('split')
      const { runId } = await api.graph.startSplit({
        newsId: this.currentNewsId,
        mode: this.executionMode,
      })
      this.runId = runId
    },

    async startVerify() {
      if (!this.currentNewsId || !this.activeClaimId) return
      const api = getApi()
      if (!api) return
      this.graphStatus = 'running'
      this.graphError = null
      this.graphType = 'verify'
      this.initFlow('verify')
      this.selectedClaimId = this.activeClaimId
      const { runId } = await api.graph.startVerify({
        newsId: this.currentNewsId,
        claimId: this.activeClaimId,
        mode: this.executionMode,
      })
      this.runId = runId
    },

    async runNextVerify() {
      const queue = this.claimsToVerify
      if (this.verifyQueueIndex >= queue.length) {
        this.pipelineStatus = 'completed'
        this.graphStatus = 'completed'
        this.activeClaimId = null
        this.runId = null
        this.graphType = null
        this.nextNode = null
        this.flowNodes = []
        return
      }
      this.activeClaimId = queue[this.verifyQueueIndex]
      await this.startVerify()
    },

    async setExecutionMode(mode: ExecutionMode) {
      this.executionMode = mode
      if (this.runId) {
        await getApi()?.graph.setMode(this.runId, mode)
      }
    },

    setCommitMergedClaims(claims: RawClaimDTO[]) {
      this.commitMergedClaims = claims.map(c => ({ ...c }))
    },

    async continueCommit(patch: GraphStatePatch) {
      if (!this.runId) return
      const autoPassSave = (this.nextNode === 'merge' || this.nextNode === 'save')
        && (this.graphType === 'split' || this.graphType === 'verify')
      if (autoPassSave) {
        this.pendingCommitPatch = patch
      }
      await this.resume(patch)
    },

    async resume(modifications: GraphStatePatch) {
      if (!this.runId) return
      const plain = modifications === null
        ? null
        : JSON.parse(JSON.stringify(modifications)) as GraphStatePatch
      await getApi()?.graph.resume(this.runId, plain)
      this.graphStatus = 'running'
      this.nextNode = null
      for (const node of this.flowNodes) {
        if (node.phase === 'paused') node.phase = 'active'
      }
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
      this.pipelineStatus = 'idle'
      this.claimsToVerify = []
      this.activeClaimId = null
      this.verifyQueueIndex = 0
      this.commitMergedClaims = null
      this.pendingCommitPatch = undefined
      this.resetFlow()
    },

    initSplitCommitDraft(state: SplitGraphStateDTO) {
      this.commitMergedClaims = state.mergedClaims.map(c => ({ ...c }))
    },

    async handleInterrupted(payload: GraphInterruptedPayload) {
      this.runId = payload.runId
      this.graphType = payload.graphType
      this.graphStatus = 'interrupted'
      this.nextNode = payload.nextNode
      this.graphState = JSON.parse(JSON.stringify(payload.state)) as typeof payload.state

      if (
        this.pendingCommitPatch !== undefined
        && payload.graphType === 'split'
        && payload.nextNode === 'save'
      ) {
        const patch = this.pendingCommitPatch
        this.pendingCommitPatch = undefined
        this.nextNode = 'save'
        if ('mergedClaims' in payload.state) {
          this.initSplitCommitDraft(payload.state)
        }
        await this.resume(patch)
        return
      }

      if (
        this.pendingCommitPatch !== undefined
        && payload.graphType === 'verify'
        && payload.nextNode === 'save'
      ) {
        const patch = this.pendingCommitPatch
        this.pendingCommitPatch = undefined
        await this.resume(patch)
        return
      }

      if (payload.graphType === 'split' && (payload.nextNode === 'merge' || payload.nextNode === 'save')) {
        if ('mergedClaims' in payload.state) {
          this.initSplitCommitDraft(payload.state)
        }
      } else if (payload.nextNode === 'subAgent') {
        this.buildFanOutFromState(payload.state)
        this.selectedFlowNodeId = null
      }
      this.syncFlowPaused(payload.nextNode)

      if (this.executionMode === 'auto') {
        await this.resume(null)
      }
    },

    async handleCompleted(payload: GraphCompletedPayload) {
      this.graphState = JSON.parse(JSON.stringify(payload.state)) as typeof payload.state
      this.nextNode = null
      this.commitMergedClaims = null
      this.pendingCommitPatch = undefined
      for (const node of this.flowNodes) {
        if (node.phase !== 'hidden') node.phase = 'done'
      }
      await this.refreshCurrentNews()

      if (this.pipelineStatus === 'running') {
        if (payload.graphType === 'split') {
          const claimIds = this.currentNews?.claims.map(c => c.claimId) ?? []
          if (this.executionMode === 'auto') {
            this.graphStatus = 'running'
            this.claimsToVerify = claimIds
            this.verifyQueueIndex = 0
            await this.runNextVerify()
          } else {
            this.claimsToVerify = [...claimIds]
            this.pipelineStatus = 'selectClaims'
            this.graphStatus = 'idle'
            this.runId = null
            this.graphType = null
            this.graphState = null
            this.flowNodes = []
            this.selectedFlowNodeId = null
          }
          await this.loadNewsList()
          return
        }
        if (payload.graphType === 'verify') {
          this.graphStatus = 'completed'
          this.verifyQueueIndex++
          await this.loadNewsList()
          await this.runNextVerify()
          return
        }
      }

      this.graphStatus = 'completed'
      await this.loadNewsList()
    },

    handleError(payload: GraphErrorPayload) {
      this.graphStatus = 'error'
      this.graphError = payload.error
      if (this.pipelineStatus === 'running') {
        this.pipelineStatus = 'error'
      }
    },
  },
})
