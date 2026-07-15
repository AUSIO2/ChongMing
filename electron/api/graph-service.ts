import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ExecutionMode } from '../shared/types'
import { AppError, ErrorCode, errUpdateNormalize } from '../shared/errors'
import type { GraphRunSession, RunGraphOptions } from '../shared/graph-utils'
import { graphRunInterrupt } from '../shared/graph-utils'
import { IPC_CHANNELS } from './channels'
import { graphEmit } from './graph-events'
import type {
  GraphActiveRun,
  GraphCompletedPayload,
  GraphErrorPayload,
  GraphInterruptedPayload,
  GraphProgressPayload,
  GraphStatePayload,
  GraphStatePatch,
  TransitionKey,
  GraphSplitState,
  GraphParseState,
  StartGraphResult,
  StartTransitionInput,
  GraphVerifyState,
  RestoreRunInput,
} from './types'
import type { GraphProgressEventLocal } from '../shared/graph-utils'
import {
  mapIdReadNodeFocus,
  mapIdReadInterruptFocus,
  mapIdCreateParse,
  mapIdReadChain,
  mapIdReadTransitionScope,
} from '../shared/map-ids'
import {
  transitionReadSpec,
  type TransitionRunContext,
} from '../transitions/registry'
import { MAP_DEFAULT_SCOPE } from '../shared/map-scope'

type WindowGetter = () => BrowserWindow | null

type ResumeGate = 'idle' | 'waiting' | 'done'

interface ActiveRun extends GraphRunSession {
  transitionKey: TransitionKey
  mapId: string
  parentNodeId: string
  cancelled: boolean
  resumeResolve: ((value: GraphStatePatch) => void) | null
  resumeGate: ResumeGate
  resumeReadyPromise: Promise<void>
  markResumeReady: () => void
  suppressNextInterruptUi?: boolean
  runId: string
  lastInterrupt?: Pick<
    GraphInterruptedPayload,
    'nextNode' | 'focus' | 'pendingTool' | 'state'
  >
}

const activeRuns = new Map<string, ActiveRun>()

function graphReadScopeNodeId(
  transitionKey: TransitionKey,
  parentNodeId: string,
  scopeNodeId?: string,
): string {
  return scopeNodeId
    ?? mapIdReadTransitionScope(transitionKey, parentNodeId)
    ?? MAP_DEFAULT_SCOPE
}

function sendToRenderer(
  getWindow: WindowGetter,
  channel: string,
  payload: unknown,
): void {
  graphEmit(channel, payload)
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

function serialReadTransitionState(
  transitionKey: TransitionKey,
  state: Record<string, unknown>,
): GraphSplitState | GraphVerifyState | GraphParseState {
  const spec = transitionReadSpec(transitionKey)
  return spec.serialize(state)
}

function createInterruptHandler(
  runId: string,
  _run: ActiveRun,
  getWindow: WindowGetter,
) {
  return async (
    currentState: Record<string, unknown>,
    nextNode: string,
  ): Promise<Record<string, unknown> | null> => {
    const active = activeRuns.get(runId)
    if (!active || active.cancelled) return null

    const mode = active.mode
    const state = serialReadTransitionState(active.transitionKey, currentState)
    const { focus, pendingTool } = mapIdReadInterruptFocus(
      active.transitionKey,
      nextNode,
      state,
    )

    const payload: GraphInterruptedPayload = {
      runId,
      mapId: active.mapId,
      transitionKey: active.transitionKey,
      parentNodeId: active.parentNodeId,
      nextNode: nextNode as GraphInterruptedPayload['nextNode'],
      mode,
      state,
      focus,
      pendingTool,
    }

    active.lastInterrupt = {
      nextNode: payload.nextNode,
      focus,
      pendingTool,
      state,
    }

    console.log(
      `[graph:${active.transitionKey}] interrupt runId=${runId} next=${payload.nextNode}`,
    )
    if (!active.suppressNextInterruptUi) {
      sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_INTERRUPTED, payload)
    } else {
      active.suppressNextInterruptUi = false
    }

    const modifications = await waitForResume(runId)
    if (!modifications || active.cancelled) return null

    if (modifications.mode) {
      active.mode = modifications.mode
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
    mapId: run.mapId,
    transitionKey: run.transitionKey,
    parentNodeId: run.parentNodeId,
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

function attachStateProjectHandler(
  run: ActiveRun,
  getWindow: WindowGetter,
): void {
  run.onStateProject = (currentState, completedNode) => {
    const state = serialReadTransitionState(
      run.transitionKey,
      currentState as Record<string, unknown>,
    )
    const payload: GraphStatePayload = {
      runId: run.runId,
      mapId: run.mapId,
      transitionKey: run.transitionKey,
      parentNodeId: run.parentNodeId,
      completedNode,
      state,
    }
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_STATE, payload)
  }
}

function createRunSession(
  runId: string,
  ctx: TransitionRunContext,
  mode: ExecutionMode,
  loadNode: string,
): ActiveRun {
  let markResumeReady!: () => void
  const resumeReadyPromise = new Promise<void>((resolve) => {
    markResumeReady = resolve
  })
  return {
    runId,
    transitionKey: ctx.transitionKey,
    mapId: ctx.mapId,
    parentNodeId: ctx.parentNodeId,
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
    fanoutReadNodeId: ctx.transitionKey === '0-1'
      ? (_instruction, parentNodeId) => {
          const chainId = mapIdReadChain(parentNodeId)
          return chainId ? mapIdCreateParse(chainId) : parentNodeId
        }
      : undefined,
  }
}

async function runGraphLoop(
  ctx: TransitionRunContext,
  threadId: string,
  onInterrupt: ReturnType<typeof createInterruptHandler>,
  session: ActiveRun,
  options?: RunGraphOptions,
) {
  const { agentActivateForMap } = await import('./agent-config')
  const agents = await agentActivateForMap(ctx.mapId)
  const spec = transitionReadSpec(ctx.transitionKey)
  const graph = spec.buildGraph(agents)
  const initial = spec.readInitialInput(ctx, threadId)
  return graphRunInterrupt(
    graph,
    {
      ...initial,
      mode: ctx.mode ?? session.mode ?? 'auto',
    },
    { onInterrupt },
    threadId,
    session,
    options,
  )
}

async function executeRun(opts: {
  runId: string
  ctx: TransitionRunContext
  getWindow: WindowGetter
  threadId: string
  options?: RunGraphOptions
}): Promise<void> {
  const { runId, ctx, getWindow, threadId, options } = opts
  const run = activeRuns.get(runId)!
  const spec = transitionReadSpec(ctx.transitionKey)
  attachProgressHandlers(run, getWindow)
  attachStateProjectHandler(run, getWindow)
  console.log(
    `[graph:${ctx.transitionKey}] 开始 runId=${runId} mapId=${run.mapId} parent=${run.parentNodeId}`,
  )
  sendProgress(getWindow, run, { event: 'node_enter', node: spec.loadNode })
  try {
    const result = await runGraphLoop(
      ctx,
      threadId,
      createInterruptHandler(runId, run, getWindow),
      run,
      options,
    )

    if (activeRuns.get(runId)?.cancelled) {
      console.log(`[graph:${ctx.transitionKey}] 已取消 runId=${runId}`)
      return
    }

    const payload: GraphCompletedPayload = {
      runId,
      mapId: run.mapId,
      transitionKey: run.transitionKey,
      parentNodeId: run.parentNodeId,
      state: spec.serialize(result as Record<string, unknown>),
    }
    if (ctx.transitionKey === '1-2') {
      const s = payload.state as GraphSplitState
      console.log(
        `[graph:1-2] 完成 mapId=${s.mapId} claims=${s.mergedClaims?.length ?? 0}`,
      )
    }
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_COMPLETED, payload)
  } catch (error) {
    const appError = errUpdateNormalize(error, ErrorCode.GRAPH_EXECUTION_FAILED)
    console.error(
      `[graph:${ctx.transitionKey}] 失败 runId=${runId} code=${appError.code}`
      + (appError.failedNode ? ` node=${appError.failedNode}` : '')
      + `:`,
      appError.msg,
      appError.cause ?? '',
    )
    const payload: GraphErrorPayload = {
      runId,
      mapId: run.mapId,
      transitionKey: run.transitionKey,
      parentNodeId: run.parentNodeId,
      code: appError.code,
      msg: appError.msg,
      ...(appError.failedNode ? { failedNode: appError.failedNode } : {}),
    }
    sendToRenderer(getWindow, IPC_CHANNELS.GRAPH_ERROR, payload)
  } finally {
    const pending = activeRuns.get(runId)
    if (pending?.resumeGate === 'idle') {
      pending.markResumeReady()
    }
    activeRuns.delete(runId)
  }
}

export function runTransition(
  input: StartTransitionInput,
  getWindow: WindowGetter,
): StartGraphResult {
  const runId = randomUUID()
  const threadId = runId
  const ctx: TransitionRunContext = {
    mapId: input.mapId,
    transitionKey: input.transitionKey,
    parentNodeId: input.parentNodeId,
    scopeNodeId: graphReadScopeNodeId(
      input.transitionKey,
      input.parentNodeId,
      input.scopeNodeId,
    ),
    mode: input.mode,
  }
  const spec = transitionReadSpec(ctx.transitionKey)
  const session = createRunSession(
    runId,
    ctx,
    input.mode ?? 'auto',
    spec.loadNode,
  )
  session.threadId = threadId
  activeRuns.set(runId, session)
  void executeRun({ runId, ctx, getWindow, threadId })
  return { runId }
}

export async function runRestoreSession(
  input: RestoreRunInput,
  getWindow: WindowGetter,
): Promise<StartGraphResult> {
  if (activeRuns.has(input.runId)) {
    const existing = activeRuns.get(input.runId)!
    await existing.resumeReadyPromise
    return { runId: input.runId }
  }

  const ctx: TransitionRunContext = {
    mapId: input.mapId,
    transitionKey: input.transitionKey,
    parentNodeId: input.parentNodeId,
    scopeNodeId: graphReadScopeNodeId(
      input.transitionKey,
      input.parentNodeId,
      input.scopeNodeId,
    ),
    mode: input.mode,
  }
  const spec = transitionReadSpec(ctx.transitionKey)
  const session = createRunSession(
    input.runId,
    ctx,
    input.mode,
    spec.loadNode,
  )
  session.threadId = input.runId
  session.fanoutEmitted = input.gate !== 'confirmRoute'
  session.suppressNextInterruptUi = true
  const { focus, pendingTool } = mapIdReadInterruptFocus(
    input.transitionKey,
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

  const graph = spec.buildGraph()
  try {
    const snapshot = await graph.getState({ configurable: { thread_id: input.runId } })
    if (!snapshot.next?.length) {
      activeRuns.delete(input.runId)
      throw new AppError(
        ErrorCode.GRAPH_NO_PENDING_INTERRUPT,
        `Checkpoint 无待恢复中断点（可能已跑完或 checkpoint 已失效）: ${input.runId}`,
      )
    }
  } catch (error) {
    if (!activeRuns.has(input.runId)) throw error
    activeRuns.delete(input.runId)
    if (error instanceof AppError) throw error
    throw new AppError(
      ErrorCode.GRAPH_EXECUTION_FAILED,
      `读取 checkpoint 失败: ${input.runId}`,
      { cause: error },
    )
  }

  void executeRun({
    runId: input.runId,
    ctx,
    getWindow,
    threadId: input.runId,
    options: { skipInitialInvoke: true },
  })

  await session.resumeReadyPromise
  return { runId: input.runId }
}

export function runReadSession(mapId: string): GraphActiveRun | null {
  for (const run of activeRuns.values()) {
    if (run.mapId !== mapId || run.cancelled) continue
    return {
      runId: run.runId,
      mapId: run.mapId,
      transitionKey: run.transitionKey,
      parentNodeId: run.parentNodeId,
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

export function runReadAllSessions(mapId: string): GraphActiveRun[] {
  const out: GraphActiveRun[] = []
  for (const run of activeRuns.values()) {
    if (run.mapId !== mapId || run.cancelled) continue
    out.push({
      runId: run.runId,
      mapId: run.mapId,
      transitionKey: run.transitionKey,
      parentNodeId: run.parentNodeId,
      mode: run.mode,
      threadId: run.threadId,
      nextNode: run.lastInterrupt?.nextNode,
      focus: run.lastInterrupt?.focus,
      pendingTool: run.lastInterrupt?.pendingTool,
      state: run.lastInterrupt?.state,
    })
  }
  return out
}

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
