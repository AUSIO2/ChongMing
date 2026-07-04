import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ExecutionMode } from '../shared/types'
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
  ActiveRunDTO,
  GraphCompletedPayload,
  GraphErrorPayload,
  GraphInterruptFocus,
  GraphInterruptedPayload,
  GraphProgressPayload,
  GraphStatePatch,
  GraphType,
  MapToolKind,
  SplitGraphStateDTO,
  StartGraphResult,
  StartSplitInput,
  StartVerifyInput,
  VerifyGraphStateDTO,
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
  state: SplitGraphStateDTO | VerifyGraphStateDTO,
): { focus?: GraphInterruptFocus; pendingTool?: MapToolKind } {
  if (nextNode === 'subAgent') {
    if (graphType === 'split') {
      return { focus: { kind: 'news', id: NEWS_ROOT_ID }, pendingTool: 'invoke' }
    }
    const vs = state as VerifyGraphStateDTO
    return { focus: { kind: 'claim', id: vs.claimId }, pendingTool: 'invoke' }
  }
  if (nextNode === 'merge') {
    if (graphType === 'split') {
      return { focus: { kind: 'news', id: NEWS_ROOT_ID }, pendingTool: 'validate' }
    }
    const vs = state as VerifyGraphStateDTO
    return { focus: { kind: 'claim', id: vs.claimId }, pendingTool: 'validate' }
  }
  if (nextNode === 'save') {
    if (graphType === 'split') {
      const ss = state as SplitGraphStateDTO
      return {
        focus: { kind: 'claim', id: mergedClaimNodeId(ss.saveIndex) },
        pendingTool: 'save',
      }
    }
    const vs = state as VerifyGraphStateDTO
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

async function executeSplitRun(
  runId: string,
  input: StartSplitInput,
  getWindow: WindowGetter,
): Promise<void> {
  const run = activeRuns.get(runId)!
  const graphType: GraphType = 'split'
  attachProgressHandlers(run, getWindow)
  sendProgress(getWindow, runId, graphType, { event: 'node_enter', node: 'loadNews' })
  try {
    const graph = buildSplitGraph(getSplitGraphConfig())
    const result = await runSplitGraph(graph, input, {
      onInterrupt: createInterruptHandler(runId, graphType, getWindow),
    }, run)

    if (activeRuns.get(runId)?.cancelled) return

    const payload: GraphCompletedPayload = {
      runId,
      graphType,
      state: serializeSplitState(result),
    }
    console.log(
      `[graph:split] 完成 newsId=${input.newsId} claims=${result.mergedClaims?.length ?? 0}`,
    )
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_COMPLETED, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[graph:split] 失败 runId=${runId}:`, message)
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

async function executeVerifyRun(
  runId: string,
  input: StartVerifyInput,
  getWindow: WindowGetter,
): Promise<void> {
  const run = activeRuns.get(runId)!
  const graphType: GraphType = 'verify'
  attachProgressHandlers(run, getWindow)
  sendProgress(getWindow, runId, graphType, { event: 'node_enter', node: 'loadClaim' })
  try {
    const graph = buildVerifyGraph(getVerifyGraphConfig())
    const result = await runVerifyGraph(graph, input, {
      onInterrupt: createInterruptHandler(runId, graphType, getWindow),
    }, run)

    if (activeRuns.get(runId)?.cancelled) return

    const payload: GraphCompletedPayload = {
      runId,
      graphType,
      state: serializeVerifyState(result),
    }
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_COMPLETED, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[graph:verify] 失败 runId=${runId}:`, message)
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
  void executeSplitRun(runId, input, getWindow)
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
  void executeVerifyRun(runId, input, getWindow)
  return { runId }
}

export function getActiveRun(newsId: string): ActiveRunDTO | null {
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
