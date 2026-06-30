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
  GraphCompletedPayload,
  GraphErrorPayload,
  GraphInterruptedPayload,
  GraphStatePatch,
  GraphType,
  StartGraphResult,
  StartSplitInput,
  StartVerifyInput,
} from './types'

type WindowGetter = () => BrowserWindow | null

interface ActiveRun extends GraphRunSession {
  graphType: GraphType
  cancelled: boolean
  resumeResolve: ((value: GraphStatePatch) => void) | null
}

const activeRuns = new Map<string, ActiveRun>()

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
    const payload: GraphInterruptedPayload = graphType === 'split'
      ? {
          runId,
          graphType,
          nextNode: nextNode as GraphInterruptedPayload['nextNode'],
          mode,
          state: serializeSplitState(currentState as Parameters<typeof serializeSplitState>[0]),
        }
      : {
          runId,
          graphType,
          nextNode: nextNode as GraphInterruptedPayload['nextNode'],
          mode,
          state: serializeVerifyState(currentState as Parameters<typeof serializeVerifyState>[0]),
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

function createRunSession(
  graphType: GraphType,
  mode: ExecutionMode,
): ActiveRun {
  return {
    graphType,
    mode,
    cancelled: false,
    resumeResolve: null,
    graph: undefined,
    config: undefined,
  }
}

async function executeSplitRun(
  runId: string,
  input: StartSplitInput,
  getWindow: WindowGetter,
): Promise<void> {
  const run = activeRuns.get(runId)!
  const graphType: GraphType = 'split'
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
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_COMPLETED, payload)
  } catch (error) {
    const payload: GraphErrorPayload = {
      runId,
      graphType,
      error: error instanceof Error ? error.message : String(error),
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
    const payload: GraphErrorPayload = {
      runId,
      graphType,
      error: error instanceof Error ? error.message : String(error),
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
  activeRuns.set(runId, createRunSession('split', input.mode ?? 'auto'))
  void executeSplitRun(runId, input, getWindow)
  return { runId }
}

export function startVerify(
  input: StartVerifyInput,
  getWindow: WindowGetter,
): StartGraphResult {
  const runId = randomUUID()
  activeRuns.set(runId, createRunSession('verify', input.mode ?? 'auto'))
  void executeVerifyRun(runId, input, getWindow)
  return { runId }
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
