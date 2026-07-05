import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ExecutionMode } from '../shared/types'
import { AppError, ErrorCode, errUpdateNormalize } from '../shared/errors'
import type { GraphRunSession, RunGraphOptions } from '../shared/graph-utils'
import { graphRunInterrupt } from '../shared/graph-utils'
import { splitBuildGraph } from '../fact-extractor/extractor'
import { verifyBuildGraph } from '../fact-verifier/verifier'
import { agentReadSplitConfig, agentReadVerifyConfig } from './agent-config'
import { IPC_CHANNELS } from './channels'
import {
  serialReadSplitState,
  serialReadVerifyState,
} from './serialize'
import type {
  GraphActiveRun,
  GraphCompletedPayload,
  GraphErrorPayload,
  GraphInterruptedPayload,
  GraphProgressPayload,
  GraphStatePatch,
  GraphType,
  GraphSplitState,
  StartGraphResult,
  StartSplitInput,
  StartVerifyInput,
  GraphVerifyState,
  RestoreRunInput,
} from './types'
import type { GraphProgressEventLocal } from '../shared/graph-utils'
import {
  mapIdReadNodeFocus,
  mapIdReadInterruptFocus,
} from '../shared/map-ids'

type WindowGetter = () => BrowserWindow | null

type ResumeGate = 'idle' | 'waiting' | 'done'

interface ActiveRun extends GraphRunSession {
  graphType: GraphType
  newsId: string
  cancelled: boolean
  resumeResolve: ((value: GraphStatePatch) => void) | null
  resumeGate: ResumeGate
  resumeReadyPromise: Promise<void>
  markResumeReady: () => void
  /** restore 后首次 interrupt 不向渲染进程重复发 GRAPH_INTERRUPTED */
  suppressNextInterruptUi?: boolean
  runId: string
  lastInterrupt?: Pick<
    GraphInterruptedPayload,
    'nextNode' | 'focus' | 'pendingTool' | 'state'
  >
}

const activeRuns = new Map<string, ActiveRun>()

type RunStartInput = StartSplitInput | StartVerifyInput

interface GraphRunSpec {
  loadNode: string
  buildGraph: () => ReturnType<typeof splitBuildGraph>
  readInitialInput: (input: RunStartInput, threadId: string) => Record<string, unknown>
  serialize: (state: Record<string, unknown>) => GraphCompletedPayload['state']
  logDone?: (state: Record<string, unknown>) => string
}

const GRAPH_RUN_SPEC: Record<GraphType, GraphRunSpec> = {
  split: {
    loadNode: 'loadNews',
    buildGraph: () => splitBuildGraph(agentReadSplitConfig()),
    readInitialInput: (input, threadId) => ({
      newsId: (input as StartSplitInput).newsId,
      mode: input.mode,
      threadId,
    }),
    serialize: state => serialReadSplitState(state as unknown as GraphSplitState),
    logDone: state => {
      const s = state as unknown as GraphSplitState
      return `[graph:split] 完成 newsId=${s.newsId} claims=${s.mergedClaims?.length ?? 0}`
    },
  },
  verify: {
    loadNode: 'loadClaim',
    buildGraph: () => verifyBuildGraph(agentReadVerifyConfig()),
    readInitialInput: (input, threadId) => ({
      newsId: input.newsId,
      claimId: (input as StartVerifyInput).claimId,
      mode: input.mode,
      threadId,
    }),
    serialize: state => serialReadVerifyState(state as unknown as GraphVerifyState),
  },
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
    run.resumeGate = 'waiting'
    run.resumeResolve = resolve
    run.markResumeReady()
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
      ? serialReadSplitState(currentState as Parameters<typeof serialReadSplitState>[0])
      : serialReadVerifyState(currentState as Parameters<typeof serialReadVerifyState>[0])
    const { focus, pendingTool } = mapIdReadInterruptFocus(graphType, nextNode, state)

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

    console.log(
      `[graph:${graphType}] interrupt runId=${runId} next=${payload.nextNode}`,
    )
    if (!run.suppressNextInterruptUi) {
      sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_INTERRUPTED, payload)
    } else {
      run.suppressNextInterruptUi = false
    }

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
  run: ActiveRun,
  event: GraphProgressEventLocal,
): void {
  const payload: GraphProgressPayload = {
    runId: run.runId,
    newsId: run.newsId,
    graphType: run.graphType,
    ...event,
  }
  sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_PROGRESS, payload)
}

function attachProgressHandlers(
  run: ActiveRun,
  getWindow: WindowGetter,
): void {
  run.onProgress = event => sendProgress(getWindow, run, event)
}

function createRunSession(
  runId: string,
  graphType: GraphType,
  newsId: string,
  mode: ExecutionMode,
  loadNode: string,
): ActiveRun {
  let markResumeReady!: () => void
  const resumeReadyPromise = new Promise<void>((resolve) => {
    markResumeReady = resolve
  })
  return {
    runId,
    graphType,
    newsId,
    mode,
    loadNode,
    cancelled: false,
    resumeResolve: null,
    resumeGate: 'idle',
    resumeReadyPromise,
    markResumeReady,
    graph: undefined,
    config: undefined,
    fanoutEmitted: false,
  }
}

function runGraphLoop(
  graphType: GraphType,
  input: RunStartInput,
  threadId: string,
  onInterrupt: ReturnType<typeof createInterruptHandler>,
  session: ActiveRun,
  options?: RunGraphOptions,
) {
  const spec = GRAPH_RUN_SPEC[graphType]
  const graph = spec.buildGraph()
  const initial = spec.readInitialInput(input, threadId)
  return graphRunInterrupt(
    graph,
    {
      ...initial,
      mode: input.mode ?? session.mode ?? 'auto',
    },
    { onInterrupt },
    threadId,
    session,
    options,
  )
}

async function executeRun(opts: {
  runId: string
  graphType: GraphType
  getWindow: WindowGetter
  input: RunStartInput
  threadId: string
  options?: RunGraphOptions
}): Promise<void> {
  const { runId, graphType, getWindow, input, threadId, options } = opts
  const run = activeRuns.get(runId)!
  const spec = GRAPH_RUN_SPEC[graphType]
  attachProgressHandlers(run, getWindow)
  console.log(`[graph:${graphType}] 开始 runId=${runId} newsId=${run.newsId}`)
  sendProgress(getWindow, run, { event: 'node_enter', node: spec.loadNode })
  try {
    const result = await runGraphLoop(
      graphType,
      input,
      threadId,
      createInterruptHandler(runId, graphType, getWindow),
      run,
      options,
    )

    if (activeRuns.get(runId)?.cancelled) {
      console.log(`[graph:${graphType}] 已取消 runId=${runId}`)
      return
    }

    const payload: GraphCompletedPayload = {
      runId,
      graphType,
      state: spec.serialize(result as Record<string, unknown>),
    }
    if (spec.logDone) console.log(spec.logDone(result as Record<string, unknown>))
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_COMPLETED, payload)
  } catch (error) {
    const appError = errUpdateNormalize(error, ErrorCode.GRAPH_EXECUTION_FAILED)
    console.error(
      `[graph:${graphType}] 失败 runId=${runId} code=${appError.code}`
      + (appError.failedNode ? ` node=${appError.failedNode}` : '')
      + `:`,
      appError.msg,
      appError.cause ?? '',
    )
    const payload: GraphErrorPayload = {
      runId,
      newsId: run.newsId,
      graphType,
      code: appError.code,
      msg: appError.msg,
      ...(appError.failedNode ? { failedNode: appError.failedNode } : {}),
    }
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_ERROR, payload)
  } finally {
    activeRuns.delete(runId)
  }
}

function runCreateInternal(
  graphType: GraphType,
  input: RunStartInput,
  getWindow: WindowGetter,
): StartGraphResult {
  const runId = randomUUID()
  const threadId = runId
  const spec = GRAPH_RUN_SPEC[graphType]
  const session = createRunSession(
    runId,
    graphType,
    input.newsId,
    input.mode ?? 'auto',
    spec.loadNode,
  )
  session.threadId = threadId
  activeRuns.set(runId, session)
  void executeRun({ runId, graphType, getWindow, input, threadId })
  return { runId }
}

export function runCreate(
  graphType: 'split',
  input: StartSplitInput,
  getWindow: WindowGetter,
): StartGraphResult
export function runCreate(
  graphType: 'verify',
  input: StartVerifyInput,
  getWindow: WindowGetter,
): StartGraphResult
export function runCreate(
  graphType: GraphType,
  input: RunStartInput,
  getWindow: WindowGetter,
): StartGraphResult {
  return runCreateInternal(graphType, input, getWindow)
}

export function runCreateSplit(
  input: StartSplitInput,
  getWindow: WindowGetter,
): StartGraphResult {
  return runCreate('split', input, getWindow)
}

export function runCreateVerify(
  input: StartVerifyInput,
  getWindow: WindowGetter,
): StartGraphResult {
  return runCreate('verify', input, getWindow)
}

/**
 * 从 News.mapRun + MongoDBSaver checkpoint 恢复 HITL 等待循环（进程重启后）。
 * 在 interrupt 循环进入 waitForResume 后才 resolve，避免 resume 被静默丢弃。
 */
export async function runRestoreSession(
  input: RestoreRunInput,
  getWindow: WindowGetter,
): Promise<StartGraphResult> {
  if (activeRuns.has(input.runId)) {
    const existing = activeRuns.get(input.runId)!
    await existing.resumeReadyPromise
    return { runId: input.runId }
  }

  const spec = GRAPH_RUN_SPEC[input.graphType]
  const session = createRunSession(
    input.runId,
    input.graphType,
    input.newsId,
    input.mode,
    spec.loadNode,
  )
  session.threadId = input.runId
  session.fanoutEmitted = input.gate !== 'confirmRoute'
  session.suppressNextInterruptUi = true
  const { focus, pendingTool } = mapIdReadInterruptFocus(
    input.graphType,
    input.gate,
    input.draft,
  )
  session.lastInterrupt = {
    nextNode: input.gate,
    focus: focus ?? (input.activeNodeId
      ? mapIdReadNodeFocus(input.activeNodeId)
      : undefined),
    pendingTool: pendingTool ?? input.pendingTool,
    state: input.draft,
  }
  activeRuns.set(input.runId, session)

  const restoreInput: RunStartInput = input.graphType === 'split'
    ? { newsId: input.newsId, mode: input.mode }
    : {
        newsId: input.newsId,
        claimId: 'claimId' in input.draft ? input.draft.claimId : '',
        mode: input.mode,
      }

  void executeRun({
    runId: input.runId,
    graphType: input.graphType,
    getWindow,
    input: restoreInput,
    threadId: input.runId,
    options: { skipInitialInvoke: true },
  })

  await session.resumeReadyPromise
  return { runId: input.runId }
}

export function runReadSession(newsId: string): GraphActiveRun | null {
  for (const run of activeRuns.values()) {
    if (run.newsId !== newsId || run.cancelled) continue
    return {
      runId: run.runId,
      newsId: run.newsId,
      graphType: run.graphType,
      mode: run.mode,
      threadId: run.threadId,
      nextNode: run.lastInterrupt?.nextNode,
      focus: run.lastInterrupt?.focus,
      pendingTool: run.lastInterrupt?.pendingTool,
      state: run.lastInterrupt?.state,
    }
  }
  return null
}

/** 恢复挂起的 interrupt。重复 resume 视为幂等 no-op（避免连点报错）。 */
export function runUpdateResume(runId: string, modifications: GraphStatePatch): void {
  const run = activeRuns.get(runId)
  if (!run) {
    throw new AppError(ErrorCode.GRAPH_RUN_NOT_FOUND, `Run not found: ${runId}`)
  }
  if (run.resumeGate === 'idle') {
    throw new AppError(
      ErrorCode.GRAPH_NO_PENDING_INTERRUPT,
      `Graph run not waiting for resume: ${runId}`,
    )
  }
  if (run.resumeGate === 'done' || !run.resumeResolve) {
    return
  }

  run.lastInterrupt = undefined
  run.resumeGate = 'done'
  const resolve = run.resumeResolve
  run.resumeResolve = null
  resolve(modifications)
}

/** 运行中随时切换 auto / human-in-loop */
export async function runUpdateMode(runId: string, mode: ExecutionMode): Promise<void> {
  const run = activeRuns.get(runId)
  if (!run) {
    throw new AppError(ErrorCode.GRAPH_RUN_NOT_FOUND, `Run not found: ${runId}`)
  }

  run.mode = mode

  if (run.graph && run.config) {
    await run.graph.updateState(run.config, { mode })
  }

  if (mode === 'auto' && run.resumeGate === 'waiting' && run.resumeResolve) {
    run.lastInterrupt = undefined
    run.resumeGate = 'done'
    const resolve = run.resumeResolve
    run.resumeResolve = null
    resolve({ mode: 'auto' })
  }
}

export function runDeleteSession(runId: string): void {
  const run = activeRuns.get(runId)
  if (!run) return

  run.cancelled = true
  run.lastInterrupt = undefined
  if (run.resumeGate === 'waiting' && run.resumeResolve) {
    run.resumeGate = 'done'
    const resolve = run.resumeResolve
    run.resumeResolve = null
    resolve(null)
  }
  if (run.threadId) {
    void import('../shared/checkpointer').then(({ ckptDeleteThread }) =>
      ckptDeleteThread(run.threadId!),
    )
  }
}

export function runReadMode(runId: string): ExecutionMode | null {
  return activeRuns.get(runId)?.mode ?? null
}
