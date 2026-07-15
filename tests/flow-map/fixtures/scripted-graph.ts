import { mapIdCreateNews, mapIdReadChain, mapIdReadInterruptFocus } from '@flow-map/ids'
import type {
  ElectronAPI,
  ExecutionMode,
  GraphCompletedPayload,
  GraphInterruptNode,
  GraphInterruptedPayload,
  GraphParseState,
  GraphSplitState,
  GraphStatePatch,
  GraphVerifyState,
  StartTransitionInput,
  TransitionKey,
} from '../../../electron/api/types'
import type { TestSeedResult } from './timeline-matrix'
import {
  testCreateParseState,
  testCreateSplitState,
  testCreateVerifyState,
  testReadMode,
} from './graph-states'

type GraphState = GraphParseState | GraphSplitState | GraphVerifyState

const HITL_GATES: GraphInterruptNode[] = ['confirmRoute', 'validate', 'save']

interface ScriptedRun {
  runId: string
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
  scopeNodeId?: string
  mode: ExecutionMode
  gateIndex: number
  state: GraphState
  seed: TestSeedResult
}

type EventHandler<T> = (payload: T) => void

export interface ScriptedGraphOptions {
  seed: TestSeedResult
}

export function testBuildScriptedElectronAPI(options: ScriptedGraphOptions): ElectronAPI {
  const runs = new Map<string, ScriptedRun>()
  const interruptedHandlers = new Set<EventHandler<GraphInterruptedPayload>>()
  const completedHandlers = new Set<EventHandler<GraphCompletedPayload>>()
  const stateHandlers = new Set<EventHandler<import('../../electron/api/types').GraphStatePayload>>()
  const errorHandlers = new Set<EventHandler<import('../../electron/api/types').GraphErrorPayload>>()
  const progressHandlers = new Set<EventHandler<import('../../electron/api/types').GraphProgressPayload>>()

  let runCounter = 0

  function testReadState(run: ScriptedRun): GraphState {
    const { transitionKey, parentNodeId, seed } = run
    if (transitionKey === '0-1') {
      const chainId = mapIdReadChain(parentNodeId) ?? seed.chainId ?? 'aaaa'
      return testCreateParseState(parentNodeId, chainId, {
        mapId: run.mapId,
        mode: run.mode,
      })
    }
    if (transitionKey === '1-2') {
      return testCreateSplitState({
        mapId: run.mapId,
        parentNodeId,
        mode: run.mode,
        content: seed.display.content,
      })
    }
    return testCreateVerifyState(
      parentNodeId,
      run.scopeNodeId ?? seed.newsId ?? parentNodeId,
      { mapId: run.mapId, mode: run.mode },
    )
  }

  function testEmitInterrupted(run: ScriptedRun, gate: GraphInterruptNode): void {
    const { focus, pendingTool } = mapIdReadInterruptFocus(
      run.transitionKey,
      gate,
      run.state as GraphSplitState & GraphParseState & GraphVerifyState,
    )
    const payload: GraphInterruptedPayload = {
      runId: run.runId,
      mapId: run.mapId,
      transitionKey: run.transitionKey,
      parentNodeId: run.parentNodeId,
      nextNode: gate,
      mode: run.mode,
      state: structuredClone(run.state),
      focus,
      pendingTool,
    }
    for (const h of interruptedHandlers) h(payload)
  }

  function testEmitCompleted(run: ScriptedRun): void {
    const payload: GraphCompletedPayload = {
      runId: run.runId,
      mapId: run.mapId,
      transitionKey: run.transitionKey,
      parentNodeId: run.parentNodeId,
      state: structuredClone(run.state),
    }
    for (const h of completedHandlers) h(payload)
    runs.delete(run.runId)
  }

  function testSchedule(fn: () => void): void {
    setTimeout(fn, 0)
  }

  function testAdvanceAuto(run: ScriptedRun): void {
    for (const gate of HITL_GATES) {
      for (const h of stateHandlers) {
        h({
          runId: run.runId,
          mapId: run.mapId,
          transitionKey: run.transitionKey,
          parentNodeId: run.parentNodeId,
          completedNode: gate,
          state: structuredClone(run.state),
        })
      }
    }
    testEmitCompleted(run)
  }

  function testAdvanceHitl(run: ScriptedRun): void {
    const gate = HITL_GATES[run.gateIndex]
    if (!gate) {
      testEmitCompleted(run)
      return
    }
    testEmitInterrupted(run, gate)
  }

  function testApplyResume(run: ScriptedRun, patch: GraphStatePatch): void {
    if (!patch) return
    run.state = { ...run.state, ...patch } as GraphState
  }

  return {
    map: {} as ElectronAPI['map'],
    catalog: {
      async list() {
        return []
      },
    },
    graph: {
      async runTransition(input: StartTransitionInput) {
        const runId = `run-${++runCounter}`
        const state = testReadState({
          runId,
          mapId: input.mapId,
          transitionKey: input.transitionKey,
          parentNodeId: input.parentNodeId,
          scopeNodeId: input.scopeNodeId,
          mode: input.mode ?? options.seed.display.mapGraph?.mode ?? 'human-in-loop',
          gateIndex: 0,
          state: {} as GraphState,
          seed: options.seed,
        })
        const run: ScriptedRun = {
          runId,
          mapId: input.mapId,
          transitionKey: input.transitionKey,
          parentNodeId: input.parentNodeId,
          scopeNodeId: input.scopeNodeId,
          mode: input.mode ?? testReadMode(state),
          gateIndex: 0,
          state,
          seed: options.seed,
        }
        runs.set(runId, run)
        testSchedule(() => {
          if (run.mode === 'auto') testAdvanceAuto(run)
          else testAdvanceHitl(run)
        })
        return { runId }
      },

      async resume(runId, modifications) {
        const run = runs.get(runId)
        if (!run) throw new Error(`run not found: ${runId}`)
        testApplyResume(run, modifications)
        run.gateIndex += 1
        testSchedule(() => {
          if (run.mode === 'auto') {
            testAdvanceAuto(run)
            return
          }
          testAdvanceHitl(run)
        })
      },

      async setMode(runId, mode) {
        const run = runs.get(runId)
        if (!run) return
        run.mode = mode
        run.state = { ...run.state, mode } as GraphState
        // 对齐主进程：切到 auto 且仍在门闸等待时，自动跑完当前 transition
        if (mode === 'auto' && run.gateIndex < HITL_GATES.length) {
          testSchedule(() => testAdvanceAuto(run))
        }
      },

      async cancel(runId) {
        runs.delete(runId)
      },

      async getActiveRun(mapId) {
        for (const run of runs.values()) {
          if (run.mapId !== mapId) continue
          const gate = HITL_GATES[run.gateIndex]
          return {
            runId: run.runId,
            mapId: run.mapId,
            transitionKey: run.transitionKey,
            parentNodeId: run.parentNodeId,
            mode: run.mode,
            nextNode: gate,
            state: structuredClone(run.state),
          }
        }
        return null
      },

      async restore(input) {
        const runId = input.runId
        const chainId = mapIdReadChain(input.parentNodeId) ?? options.seed.chainId ?? 'aaaa'
        const state = input.transitionKey === '0-1'
          ? testCreateParseState(input.parentNodeId, chainId, {
            mapId: input.mapId,
            mode: input.mode,
            ...(input.draft as GraphParseState),
          })
          : input.transitionKey === '1-2'
            ? { ...testCreateSplitState({ mapId: input.mapId, parentNodeId: input.parentNodeId }), ...input.draft }
            : { ...testCreateVerifyState(input.parentNodeId, input.scopeNodeId ?? ''), ...input.draft }
        const gateIndex = HITL_GATES.indexOf(input.gate)
        runs.set(runId, {
          runId,
          mapId: input.mapId,
          transitionKey: input.transitionKey,
          parentNodeId: input.parentNodeId,
          scopeNodeId: input.scopeNodeId,
          mode: input.mode,
          gateIndex: gateIndex >= 0 ? gateIndex : 0,
          state: state as GraphState,
          seed: options.seed,
        })
        return { runId }
      },
    },
    events: {
      onInterrupted(cb) {
        interruptedHandlers.add(cb)
        return () => interruptedHandlers.delete(cb)
      },
      onState(cb) {
        stateHandlers.add(cb)
        return () => stateHandlers.delete(cb)
      },
      onCompleted(cb) {
        completedHandlers.add(cb)
        return () => completedHandlers.delete(cb)
      },
      onError(cb) {
        errorHandlers.add(cb)
        return () => errorHandlers.delete(cb)
      },
      onProgress(cb) {
        progressHandlers.add(cb)
        return () => progressHandlers.delete(cb)
      },
    },
  }
}

export async function testFlushAsync(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}
