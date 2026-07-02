import type {
  CreateNewsInput,
  ElectronAPI,
  ExecutionMode,
  GraphCompletedPayload,
  GraphErrorPayload,
  GraphInterruptedPayload,
  GraphProgressPayload,
  GraphStatePatch,
  GraphType,
  NewsDocumentDTO,
  NewsDocumentSummaryDTO,
  SplitGraphStateDTO,
  StartSplitInput,
  StartVerifyInput,
  VerifyGraphStateDTO,
} from '../../electron/api/types'
import {
  DEMO_DEFAULT_ROUTES,
  DEMO_MERGED_CLAIMS,
  DEMO_NEWS_CONTENT,
  DEMO_SUB_AGENT_RESULTS,
  DEMO_VISIBLE_CONTEXT,
  demoNewsContext,
  demoVerifyOpinions,
} from './demoScenario'

type Listener<T> = (payload: T) => void

function now() {
  return new Date().toISOString()
}

function id() {
  return crypto.randomUUID()
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sampleContext() {
  return demoNewsContext()
}

function sampleContent() {
  return DEMO_NEWS_CONTENT
}

function toSummary(doc: NewsDocumentDTO): NewsDocumentSummaryDTO {
  return {
    _id: doc._id,
    content: doc.content,
    claimCount: doc.claims.length,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

interface MockRun {
  graphType: GraphType
  mode: ExecutionMode
  cancelled: boolean
  resumeResolve: ((patch: GraphStatePatch) => void) | null
}

export function createMockElectronAPI(): ElectronAPI {
  const newsDb = new Map<string, NewsDocumentDTO>()
  const runs = new Map<string, MockRun>()

  const interruptedListeners = new Set<Listener<GraphInterruptedPayload>>()
  const completedListeners = new Set<Listener<GraphCompletedPayload>>()
  const errorListeners = new Set<Listener<GraphErrorPayload>>()
  const progressListeners = new Set<Listener<GraphProgressPayload>>()

  function emitProgress(payload: GraphProgressPayload) {
    progressListeners.forEach(fn => fn(payload))
  }

  function emitInterrupted(payload: GraphInterruptedPayload) {
    interruptedListeners.forEach(fn => fn(payload))
  }

  function emitCompleted(payload: GraphCompletedPayload) {
    completedListeners.forEach(fn => fn(payload))
  }

  function emitError(payload: GraphErrorPayload) {
    errorListeners.forEach(fn => fn(payload))
  }

  function waitForResume(runId: string): Promise<GraphStatePatch> {
    return new Promise((resolve) => {
      const run = runs.get(runId)
      if (!run) {
        resolve(null)
        return
      }
      run.resumeResolve = resolve
    })
  }

  async function maybeInterrupt(
    runId: string,
    graphType: GraphType,
    nextNode: GraphInterruptedPayload['nextNode'],
    mode: ExecutionMode,
    state: SplitGraphStateDTO | VerifyGraphStateDTO,
  ): Promise<GraphStatePatch> {
    if (mode !== 'human-in-loop') return null

    // 先注册 resume，再通知前端；避免同步 emit 时 auto-pass resume 找不到 resolve
    const patchPromise = waitForResume(runId)
    emitInterrupted({ runId, graphType, nextNode, mode, state })
    const patch = await patchPromise
    const run = runs.get(runId)
    if (!run || run.cancelled) return null
    run.resumeResolve = null
    return patch
  }

  function buildSplitState(news: NewsDocumentDTO, mode: ExecutionMode): SplitGraphStateDTO {
    return {
      newsId: news._id,
      mode,
      content: news.content,
      visibleContext: DEMO_VISIBLE_CONTEXT,
      routeInstructions: DEMO_DEFAULT_ROUTES.map(r => ({ ...r })),
      subAgentResults: DEMO_SUB_AGENT_RESULTS.map(r => ({
        ...r,
        claims: r.claims.map(c => ({ ...c })),
      })),
      mergedClaims: DEMO_MERGED_CLAIMS.map(c => ({ ...c })),
      rawMergeResponse: '[]',
    }
  }

  async function simulateSplit(runId: string, input: StartSplitInput) {
    const run = runs.get(runId)!
    const news = newsDb.get(input.newsId)
    if (!news) {
      emitError({ runId, graphType: 'split', error: `News not found: ${input.newsId}` })
      return
    }

    const mode = input.mode ?? run.mode
    let state = buildSplitState(news, mode)

    try {
      emitProgress({ runId, graphType: 'split', event: 'node_enter', node: 'loadNews' })
      await delay(300)
      emitProgress({ runId, graphType: 'split', event: 'node_exit', node: 'loadNews' })
      emitProgress({ runId, graphType: 'split', event: 'node_exit', node: 'route' })
      state.routeInstructions.forEach((r, i) => {
        emitProgress({
          runId,
          graphType: 'split',
          event: 'fanout_spawn',
          node: 'subAgent',
          agentName: r.agentName,
          spawnIndex: i,
        })
      })
      await delay(200)
      if (run.cancelled) return

      emitProgress({ runId, graphType: 'split', event: 'node_enter', node: 'subAgent' })
      const subPatch = await maybeInterrupt(runId, 'split', 'subAgent', mode, state)
      if (run.cancelled) return
      if (subPatch && 'routeInstructions' in subPatch && subPatch.routeInstructions) {
        state = { ...state, routeInstructions: subPatch.routeInstructions }
      }

      emitProgress({ runId, graphType: 'split', event: 'node_exit', node: 'subAgent' })
      emitProgress({ runId, graphType: 'split', event: 'node_enter', node: 'merge' })
      await delay(400)
      if (run.cancelled) return

      const mergePatch = await maybeInterrupt(runId, 'split', 'merge', mode, state)
      if (run.cancelled) return
      if (mergePatch && 'mergedClaims' in mergePatch && mergePatch.mergedClaims) {
        state = { ...state, mergedClaims: mergePatch.mergedClaims }
      }

      emitProgress({ runId, graphType: 'split', event: 'node_exit', node: 'merge' })
      emitProgress({ runId, graphType: 'split', event: 'node_enter', node: 'save' })
      await delay(300)
      if (run.cancelled) return

      const savePatch = await maybeInterrupt(runId, 'split', 'save', mode, state)
      if (run.cancelled) return
      if (savePatch && 'mergedClaims' in savePatch && savePatch.mergedClaims) {
        state = { ...state, mergedClaims: savePatch.mergedClaims }
      }

      const claims = state.mergedClaims.map((raw, i) => ({
        claimId: String(i + 1),
        content: raw.content,
        category: raw.category,
        sourceAgent: raw.sourceAgent,
      }))

      const updated: NewsDocumentDTO = {
        ...news,
        claims,
        splitMeta: {
          model: 'mock',
          subAgentResults: state.subAgentResults,
          rawMergeResponse: state.rawMergeResponse,
          splitAt: now(),
        },
        updatedAt: now(),
      }
      newsDb.set(news._id, updated)

      emitCompleted({ runId, graphType: 'split', state })
      emitProgress({ runId, graphType: 'split', event: 'node_exit', node: 'save' })
    } catch (error) {
      emitError({
        runId,
        graphType: 'split',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      runs.delete(runId)
    }
  }

  async function simulateVerify(runId: string, input: StartVerifyInput) {
    const run = runs.get(runId)!
    const news = newsDb.get(input.newsId)
    const claim = news?.claims.find(c => c.claimId === input.claimId)
    if (!news || !claim) {
      emitError({ runId, graphType: 'verify', error: 'Claim not found' })
      return
    }

    const mode = input.mode ?? run.mode
    const verifyDemo = demoVerifyOpinions(claim.content)
    let state: VerifyGraphStateDTO = {
      newsId: news._id,
      claimId: claim.claimId,
      mode,
      claimContent: claim.content,
      originalContent: news.content,
      visibleContext: DEMO_VISIBLE_CONTEXT,
      routeInstructions: verifyDemo.routeInstructions.map(r => ({ ...r })),
      subAgentOpinions: verifyDemo.subAgentOpinions.map(o => ({ ...o })),
      finalScore: verifyDemo.finalScore,
      finalReason: verifyDemo.finalReason,
      rawMergeResponse: '{}',
    }

    try {
      emitProgress({ runId, graphType: 'verify', event: 'node_enter', node: 'loadClaim' })
      await delay(300)
      emitProgress({ runId, graphType: 'verify', event: 'node_exit', node: 'loadClaim' })
      emitProgress({ runId, graphType: 'verify', event: 'node_exit', node: 'route' })
      state.routeInstructions.forEach((r, i) => {
        emitProgress({
          runId,
          graphType: 'verify',
          event: 'fanout_spawn',
          node: 'subAgent',
          agentName: r.agentName,
          spawnIndex: i,
        })
      })
      await delay(200)
      if (run.cancelled) return

      emitProgress({ runId, graphType: 'verify', event: 'node_enter', node: 'subAgent' })
      await maybeInterrupt(runId, 'verify', 'subAgent', mode, state)
      if (run.cancelled) return

      emitProgress({ runId, graphType: 'verify', event: 'node_exit', node: 'subAgent' })
      emitProgress({ runId, graphType: 'verify', event: 'node_enter', node: 'merge' })
      await delay(400)
      if (run.cancelled) return
      await maybeInterrupt(runId, 'verify', 'merge', mode, state)

      emitProgress({ runId, graphType: 'verify', event: 'node_exit', node: 'merge' })
      emitProgress({ runId, graphType: 'verify', event: 'node_enter', node: 'save' })
      await delay(300)
      if (run.cancelled) return
      const savePatch = await maybeInterrupt(runId, 'verify', 'save', mode, state)
      if (savePatch && 'finalScore' in savePatch) {
        if (savePatch.finalScore !== undefined) state.finalScore = savePatch.finalScore
        if (savePatch.finalReason !== undefined) state.finalReason = savePatch.finalReason
      }

      const claims = news.claims.map((c) => {
        if (c.claimId !== claim.claimId) return c
        return {
          ...c,
          verifyResult: {
            score: state.finalScore,
            reason: state.finalReason,
            opinions: state.subAgentOpinions,
            rawMergeResponse: state.rawMergeResponse,
            verifiedAt: now(),
          },
        }
      })

      newsDb.set(news._id, { ...news, claims, updatedAt: now() })
      emitCompleted({ runId, graphType: 'verify', state })
      emitProgress({ runId, graphType: 'verify', event: 'node_exit', node: 'save' })
    } catch (error) {
      emitError({
        runId,
        graphType: 'verify',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      runs.delete(runId)
    }
  }

  return {
    news: {
      async create(input: CreateNewsInput) {
        const ts = now()
        const doc: NewsDocumentDTO = {
          _id: input._id ?? id(),
          content: input.content,
          context: input.context,
          claims: [],
          createdAt: ts,
          updatedAt: ts,
        }
        newsDb.set(doc._id, doc)
        return doc
      },
      async list() {
        return [...newsDb.values()]
          .map(toSummary)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      },
      async get(newsId: string) {
        return newsDb.get(newsId) ?? null
      },
      async update(newsId, patch) {
        const doc = newsDb.get(newsId)
        if (!doc) throw new Error(`News not found: ${newsId}`)
        const updated = {
          ...doc,
          ...patch,
          updatedAt: now(),
        }
        newsDb.set(newsId, updated)
        return updated
      },
    },
    claims: {
      list: async newsId => newsDb.get(newsId)?.claims ?? [],
      create: async (newsId, input) => {
        const doc = newsDb.get(newsId)
        if (!doc) throw new Error(`News not found: ${newsId}`)
        const claim = {
          claimId: input.claimId ?? String(doc.claims.length + 1),
          content: input.content,
          category: input.category,
          sourceAgent: input.sourceAgent,
        }
        doc.claims.push(claim)
        doc.updatedAt = now()
        return claim
      },
      update: async (newsId, claimId, patch) => {
        const doc = newsDb.get(newsId)
        if (!doc) throw new Error(`News not found: ${newsId}`)
        const idx = doc.claims.findIndex(c => c.claimId === claimId)
        if (idx === -1) throw new Error(`Claim not found: ${claimId}`)
        doc.claims[idx] = { ...doc.claims[idx], ...patch }
        doc.updatedAt = now()
        return doc.claims[idx]
      },
      delete: async (newsId, claimId) => {
        const doc = newsDb.get(newsId)
        if (!doc) throw new Error(`News not found: ${newsId}`)
        doc.claims = doc.claims.filter(c => c.claimId !== claimId)
        doc.updatedAt = now()
      },
    },
    graph: {
      async startSplit(input) {
        const runId = id()
        runs.set(runId, {
          graphType: 'split',
          mode: input.mode ?? 'human-in-loop',
          cancelled: false,
          resumeResolve: null,
        })
        void simulateSplit(runId, input)
        return { runId }
      },
      async startVerify(input) {
        const runId = id()
        runs.set(runId, {
          graphType: 'verify',
          mode: input.mode ?? 'human-in-loop',
          cancelled: false,
          resumeResolve: null,
        })
        void simulateVerify(runId, input)
        return { runId }
      },
      async resume(runId, modifications) {
        const run = runs.get(runId)
        if (!run?.resumeResolve) return
        const resolve = run.resumeResolve
        run.resumeResolve = null
        resolve(modifications)
      },
      async setMode(runId, mode) {
        const run = runs.get(runId)
        if (!run) return
        run.mode = mode
        if (mode === 'auto' && run.resumeResolve) {
          const resolve = run.resumeResolve
          run.resumeResolve = null
          resolve(null)
        }
      },
      async cancel(runId) {
        const run = runs.get(runId)
        if (!run) return
        run.cancelled = true
        if (run.resumeResolve) {
          const resolve = run.resumeResolve
          run.resumeResolve = null
          resolve(null)
        }
        runs.delete(runId)
      },
    },
    events: {
      onInterrupted(callback) {
        interruptedListeners.add(callback)
        return () => interruptedListeners.delete(callback)
      },
      onCompleted(callback) {
        completedListeners.add(callback)
        return () => completedListeners.delete(callback)
      },
      onError(callback) {
        errorListeners.add(callback)
        return () => errorListeners.delete(callback)
      },
      onProgress(callback) {
        progressListeners.add(callback)
        return () => progressListeners.delete(callback)
      },
    },
  }
}

export function installMockElectronAPI(): void {
  if (typeof window === 'undefined' || window.electronAPI) return
  window.electronAPI = createMockElectronAPI()

  // 预置一条示例新闻，打开即可预览
  void window.electronAPI.news.create({
    content: sampleContent(),
    context: sampleContext(),
  })
}
