import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ExecutionMode } from '../shared/types'
import { errorMessage } from '../shared/errors'
import type { GraphRunSession } from '../shared/graph-utils'
import {
  buildSplitGraph,
  runSplitGraph,
} from '../fact-extractor/extractor'
import {
  buildVerifyGraph,
  runVerifyGraph,
} from '../fact-verifier/verifier'
import { getSplitGraphConfig, getVerifyGraphConfig } from './agent-config'
import { IPC_CHANNELS } from './channels'
import {
  serializeSplitState,
  serializeVerifyState,
} from './serialize'
import type {
  GraphActiveRun,
  GraphCompletedPayload,
  GraphErrorPayload,
  GraphInterruptFocus,
  GraphInterruptedPayload,
  GraphProgressPayload,
  GraphStatePatch,
  GraphType,
  GraphToolKind,
  GraphSplitState,
  StartGraphResult,
  StartSplitInput,
  StartVerifyInput,
  GraphVerifyState,
} from './types'
import type { GraphProgressEventLocal } from '../shared/graph-utils'
import {
  NEWS_ROOT_ID,
  mergedClaimNodeId,
  opinionNodeId,
} from '../shared/map-ids'

type WindowGetter = () => BrowserWindow | null

interface ActiveRun extends GraphRunSession {
  graphType: GraphType
  newsId: string
  cancelled: boolean
  resumeResolve: ((value: GraphStatePatch) => void) | null
  runId: string
  lastInterrupt?: Pick<
    GraphInterruptedPayload,
    'nextNode' | 'focus' | 'pendingTool' | 'state'
  >
}

const activeRuns = new Map<string, ActiveRun>()

function deriveInterruptFocus(
  graphType: GraphType,
  nextNode: string,
  state: GraphSplitState | GraphVerifyState,
): { focus?: GraphInterruptFocus; pendingTool?: GraphToolKind } {
  if (nextNode === 'subAgent') {
    if (graphType === 'split') {
      return { focus: { kind: 'news', id: NEWS_ROOT_ID }, pendingTool: 'invoke' }
    }
    const vs = state as GraphVerifyState
    return { focus: { kind: 'claim', id: vs.claimId }, pendingTool: 'invoke' }
  }
  if (nextNode === 'merge') {
    if (graphType === 'split') {
      return { focus: { kind: 'news', id: NEWS_ROOT_ID }, pendingTool: 'validate' }
    }
    const vs = state as GraphVerifyState
    return { focus: { kind: 'claim', id: vs.claimId }, pendingTool: 'validate' }
  }
  if (nextNode === 'save') {
    if (graphType === 'split') {
      const ss = state as GraphSplitState
      return {
        focus: { kind: 'claim', id: mergedClaimNodeId(ss.saveIndex) },
        pendingTool: 'save',
      }
    }
    const vs = state as GraphVerifyState
    const index = vs.opinionSaveIndex
    return {
      focus: { kind: 'opinion', id: opinionNodeId(vs.claimId, index) },
      pendingTool: 'save',
    }
  }
  return {}
}

function sendToRenderer(
  getWindow: WindowGetter,
  channel: string,
  payload: unknown,
): void {
  const win = getWindow()
  if (!win) return
  win.webContents.send(channel, payload)
}

function waitForResume(runId: string): Promise<GraphStatePatch> {
  return new Promise((resolve) => {
    const run = activeRuns.get(runId)
    if (!run) {
      resolve(null)
      return
    }
    run.resumeResolve = resolve
  })
}

function createInterruptHandler(
  runId: string,
  graphType: GraphType,
  getWindow: WindowGetter,
) {
  return async (
    currentState: Record<string, unknown>,
    nextNode: string,
  ): Promise<Record<string, unknown> | null> => {
    const run = activeRuns.get(runId)
    if (!run || run.cancelled) return null

    const mode = run.mode
    const state = graphType === 'split'
      ? serializeSplitState(currentState as Parameters<typeof serializeSplitState>[0])
      : serializeVerifyState(currentState as Parameters<typeof serializeVerifyState>[0])
    const { focus, pendingTool } = deriveInterruptFocus(graphType, nextNode, state)

    const payload: GraphInterruptedPayload = {
      runId,
      graphType,
      nextNode: nextNode as GraphInterruptedPayload['nextNode'],
      mode,
      state,
      focus,
      pendingTool,
    }

    run.lastInterrupt = {
      nextNode: payload.nextNode,
      focus,
      pendingTool,
      state,
    }

    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_INTERRUPTED, payload)

    const modifications = await waitForResume(runId)
    if (!modifications || run.cancelled) return null

    if (modifications.mode) {
      run.mode = modifications.mode
    }
    return modifications as Record<string, unknown>
  }
}

function sendProgress(
  getWindow: WindowGetter,
  runId: string,
  graphType: GraphType,
  event: GraphProgressEventLocal,
): void {
  const payload: GraphProgressPayload = { runId, graphType, ...event }
  sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_PROGRESS, payload)
}

function attachProgressHandlers(
  run: ActiveRun,
  getWindow: WindowGetter,
): void {
  run.onProgress = event => sendProgress(getWindow, run.runId, run.graphType, event)
}

function createRunSession(
  runId: string,
  graphType: GraphType,
  newsId: string,
  mode: ExecutionMode,
  loadNode: string,
): ActiveRun {
  return {
    runId,
    graphType,
    newsId,
    mode,
    loadNode,
    cancelled: false,
    resumeResolve: null,
    graph: undefined,
    config: undefined,
    fanoutEmitted: false,
  }
}

async function executeRun<TState>(opts: {
  runId: string
  graphType: GraphType
  getWindow: WindowGetter
  loadNode: string
  runGraph: (
    onInterrupt: ReturnType<typeof createInterruptHandler>,
    session: ActiveRun,
  ) => Promise<TState>
  serialize: (state: TState) => GraphCompletedPayload['state']
  logDone?: (state: TState) => string
}): Promise<void> {
  const { runId, graphType, getWindow, loadNode } = opts
  const run = activeRuns.get(runId)!
  attachProgressHandlers(run, getWindow)
  sendProgress(getWindow, runId, graphType, { event: 'node_enter', node: loadNode })
  try {
    const result = await opts.runGraph(
      createInterruptHandler(runId, graphType, getWindow),
      run,
    )

    if (activeRuns.get(runId)?.cancelled) return

    const payload: GraphCompletedPayload = {
      runId,
      graphType,
      state: opts.serialize(result),
    }
    if (opts.logDone) console.log(opts.logDone(result))
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_COMPLETED, payload)
  } catch (error) {
    const message = errorMessage(error)
    console.error(`[graph:${graphType}] 失败 runId=${runId}:`, message)
    const payload: GraphErrorPayload = {
      runId,
      graphType,
      error: message,
    }
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_ERROR, payload)
  } finally {
    activeRuns.delete(runId)
  }
}

export function startSplit(
  input: StartSplitInput,
  getWindow: WindowGetter,
): StartGraphResult {
  const runId = randomUUID()
  activeRuns.set(
    runId,
    createRunSession(runId, 'split', input.newsId, input.mode ?? 'auto', 'loadNews'),
  )
  void executeRun({
    runId,
    graphType: 'split',
    getWindow,
    loadNode: 'loadNews',
    runGraph: (onInterrupt, session) =>
      runSplitGraph(
        buildSplitGraph(getSplitGraphConfig()),
        input,
        { onInterrupt },
        session,
      ),
    serialize: serializeSplitState,
    logDone: (state) =>
      `[graph:split] 完成 newsId=${input.newsId} claims=${state.mergedClaims?.length ?? 0}`,
  })
  return { runId }
}

export function startVerify(
  input: StartVerifyInput,
  getWindow: WindowGetter,
): StartGraphResult {
  const runId = randomUUID()
  activeRuns.set(
    runId,
    createRunSession(runId, 'verify', input.newsId, input.mode ?? 'auto', 'loadClaim'),
  )
  void executeRun({
    runId,
    graphType: 'verify',
    getWindow,
    loadNode: 'loadClaim',
    runGraph: (onInterrupt, session) =>
      runVerifyGraph(
        buildVerifyGraph(getVerifyGraphConfig()),
        input,
        { onInterrupt },
        session,
      ),
    serialize: serializeVerifyState,
  })
  return { runId }
}

export function getActiveRun(newsId: string): GraphActiveRun | null {
  for (const run of activeRuns.values()) {
    if (run.newsId !== newsId || run.cancelled) continue
    return {
      runId: run.runId,
      newsId: run.newsId,
      graphType: run.graphType,
      mode: run.mode,
      nextNode: run.lastInterrupt?.nextNode,
      focus: run.lastInterrupt?.focus,
      pendingTool: run.lastInterrupt?.pendingTool,
      state: run.lastInterrupt?.state,
    }
  }
  return null
}

export function resumeGraph(runId: string, modifications: GraphStatePatch): void {
  const run = activeRuns.get(runId)
  if (!run?.resumeResolve) {
    throw new Error(`No pending interrupt for run: ${runId}`)
  }
  const resolve = run.resumeResolve
  run.resumeResolve = null
  resolve(modifications)
}

/** 运行中随时切换 auto / human-in-loop */
export async function setGraphMode(runId: string, mode: ExecutionMode): Promise<void> {
  const run = activeRuns.get(runId)
  if (!run) throw new Error(`Run not found: ${runId}`)

  run.mode = mode

  if (run.graph && run.config) {
    await run.graph.updateState(run.config, { mode })
  }

  // 切到 auto 且当前正挂起等待审核 → 自动继续
  if (mode === 'auto' && run.resumeResolve) {
    const resolve = run.resumeResolve
    run.resumeResolve = null
    resolve({ mode: 'auto' })
  }
}

export function cancelGraph(runId: string): void {
  const run = activeRuns.get(runId)
  if (!run) return

  run.cancelled = true
  if (run.resumeResolve) {
    const resolve = run.resumeResolve
    run.resumeResolve = null
    resolve(null)
  }
}

export function getGraphMode(runId: string): ExecutionMode | null {
  return activeRuns.get(runId)?.mode ?? null
}
