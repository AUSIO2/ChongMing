import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ExecutionMode } from '../shared/types'
import { AppError, ErrorCode, normalizeError } from '../shared/errors'
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
import {
  canWriteRouteInstructions,
  type GraphActiveRun,
  type GraphCompletedPayload,
  type GraphErrorPayload,
  type GraphInterruptFocus,
  type GraphInterruptedPayload,
  type GraphProgressPayload,
  type GraphStatePatch,
  type GraphType,
  type GraphToolKind,
  type GraphSplitState,
  type StartGraphResult,
  type StartSplitInput,
  type StartVerifyInput,
  type GraphVerifyState,
  type RestoreRunInput,
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
  if (nextNode === 'confirmRoute') {
    if (graphType === 'split') {
      return { focus: { kind: 'news', id: NEWS_ROOT_ID }, pendingTool: 'invoke' }
    }
    const vs = state as GraphVerifyState
    return { focus: { kind: 'claim', id: vs.claimId }, pendingTool: 'invoke' }
  }
  if (nextNode === 'validate') {
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

    console.log(
      `[graph:${graphType}] interrupt runId=${runId} next=${payload.nextNode}`,
    )
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
  console.log(`[graph:${graphType}] 开始 runId=${runId} newsId=${run.newsId}`)
  sendProgress(getWindow, run, { event: 'node_enter', node: loadNode })
  try {
    const result = await opts.runGraph(
      createInterruptHandler(runId, graphType, getWindow),
      run,
    )

    if (activeRuns.get(runId)?.cancelled) {
      console.log(`[graph:${graphType}] 已取消 runId=${runId}`)
      return
    }

    const payload: GraphCompletedPayload = {
      runId,
      graphType,
      state: opts.serialize(result),
    }
    if (opts.logDone) console.log(opts.logDone(result))
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_COMPLETED, payload)
  } catch (error) {
    const appError = normalizeError(error, ErrorCode.GRAPH_EXECUTION_FAILED)
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

export function startSplit(
  input: StartSplitInput,
  getWindow: WindowGetter,
): StartGraphResult {
  const runId = randomUUID()
  const threadId = `split-${input.newsId}-${runId}`
  const session = createRunSession(
    runId,
    'split',
    input.newsId,
    input.mode ?? 'auto',
    'loadNews',
  )
  session.threadId = threadId
  activeRuns.set(runId, session)
  void executeRun({
    runId,
    graphType: 'split',
    getWindow,
    loadNode: 'loadNews',
    runGraph: (onInterrupt, sess) =>
      runSplitGraph(
        buildSplitGraph(getSplitGraphConfig()),
        { newsId: input.newsId, mode: input.mode, threadId },
        { onInterrupt },
        sess,
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
  const threadId = `verify-${input.newsId}-${input.claimId}-${runId}`
  const session = createRunSession(
    runId,
    'verify',
    input.newsId,
    input.mode ?? 'auto',
    'loadClaim',
  )
  session.threadId = threadId
  activeRuns.set(runId, session)
  void executeRun({
    runId,
    graphType: 'verify',
    getWindow,
    loadNode: 'loadClaim',
    runGraph: (onInterrupt, sess) =>
      runVerifyGraph(
        buildVerifyGraph(getVerifyGraphConfig()),
        {
          newsId: input.newsId,
          claimId: input.claimId,
          mode: input.mode,
          threadId,
        },
        { onInterrupt },
        sess,
      ),
    serialize: serializeVerifyState,
  })
  return { runId }
}

/**
 * 从 News.mapRun + MongoDBSaver checkpoint 恢复 HITL 等待循环（进程重启后）。
 */
export function restoreRun(
  input: RestoreRunInput,
  getWindow: WindowGetter,
): StartGraphResult {
  if (activeRuns.has(input.runId)) {
    return { runId: input.runId }
  }

  const loadNode = input.graphType === 'split' ? 'loadNews' : 'loadClaim'
  const session = createRunSession(
    input.runId,
    input.graphType,
    input.newsId,
    input.mode,
    loadNode,
  )
  session.threadId = input.threadId
  session.fanoutEmitted = input.gate !== 'confirmRoute'
  const { focus, pendingTool } = deriveInterruptFocus(
    input.graphType,
    input.gate,
    input.draft,
  )
  session.lastInterrupt = {
    nextNode: input.gate,
    focus: focus ?? (input.activeNodeId
      ? { kind: 'news', id: input.activeNodeId }
      : undefined),
    pendingTool: pendingTool ?? input.pendingTool,
    state: input.draft,
  }
  activeRuns.set(input.runId, session)

  // MongoDBSaver 按 threadId 持久化；恢复时 skipInitialInvoke，直接进入 interrupt 循环
  if (input.graphType === 'split') {
    void executeRun({
      runId: input.runId,
      graphType: 'split',
      getWindow,
      loadNode,
      runGraph: (onInterrupt, sess) =>
        runSplitGraph(
          buildSplitGraph(getSplitGraphConfig()),
          {
            newsId: input.newsId,
            mode: input.mode,
            threadId: input.threadId,
          },
          { onInterrupt },
          sess,
          { skipInitialInvoke: true },
        ),
      serialize: serializeSplitState,
    })
  } else {
    const claimId =
      'claimId' in input.draft ? input.draft.claimId : ''
    void executeRun({
      runId: input.runId,
      graphType: 'verify',
      getWindow,
      loadNode,
      runGraph: (onInterrupt, sess) =>
        runVerifyGraph(
          buildVerifyGraph(getVerifyGraphConfig()),
          {
            newsId: input.newsId,
            claimId,
            mode: input.mode,
            threadId: input.threadId,
          },
          { onInterrupt },
          sess,
          { skipInitialInvoke: true },
        ),
      serialize: serializeVerifyState,
    })
  }

  return { runId: input.runId }
}

export function getActiveRun(newsId: string): GraphActiveRun | null {
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
export function resumeGraph(runId: string, modifications: GraphStatePatch): void {
  const run = activeRuns.get(runId)
  if (!run) {
    throw new AppError(ErrorCode.GRAPH_RUN_NOT_FOUND, `Run not found: ${runId}`)
  }
  if (!run.resumeResolve) {
    return
  }

  const pendingTool = run.lastInterrupt?.pendingTool
  let patch = modifications
  if (
    patch
    && 'routeInstructions' in patch
    && !canWriteRouteInstructions(pendingTool)
  ) {
    const { routeInstructions: _drop, ...rest } = patch
    patch = Object.keys(rest).length > 0 ? (rest as GraphStatePatch) : null
  }

  // 立刻清焦点，避免 getActiveRun 仍返回 interrupted 导致可连点「继续」
  run.lastInterrupt = undefined
  const resolve = run.resumeResolve
  run.resumeResolve = null
  resolve(patch)
}

/** 运行中随时切换 auto / human-in-loop */
export async function setGraphMode(runId: string, mode: ExecutionMode): Promise<void> {
  const run = activeRuns.get(runId)
  if (!run) {
    throw new AppError(ErrorCode.GRAPH_RUN_NOT_FOUND, `Run not found: ${runId}`)
  }

  run.mode = mode

  if (run.graph && run.config) {
    await run.graph.updateState(run.config, { mode })
  }

  // 切到 auto 且当前正挂起等待审核 → 自动继续
  if (mode === 'auto' && run.resumeResolve) {
    run.lastInterrupt = undefined
    const resolve = run.resumeResolve
    run.resumeResolve = null
    resolve({ mode: 'auto' })
  }
}

export function cancelGraph(runId: string): void {
  const run = activeRuns.get(runId)
  if (!run) return

  run.cancelled = true
  run.lastInterrupt = undefined
  if (run.resumeResolve) {
    const resolve = run.resumeResolve
    run.resumeResolve = null
    resolve(null)
  }
  if (run.threadId) {
    void import('../shared/checkpointer').then(({ deleteCheckpointThread }) =>
      deleteCheckpointThread(run.threadId!),
    )
  }
}

export function getGraphMode(runId: string): ExecutionMode | null {
  return activeRuns.get(runId)?.mode ?? null
}
