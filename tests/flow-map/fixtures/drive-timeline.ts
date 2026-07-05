import { adapterBuildIpc } from '@flow-map/adapters/electron-ipc'
import type { MapAPI } from '@flow-map/api'
import type { StateIndex } from '@flow-map/timeline'
import type { ExecutionMode, MapSnapshot } from '@flow-map/types'
import { mockMapBuildAPI, mockMapRead, mockMapReset, mockMapSeed } from './mock-map-api'
import { testBuildScriptedElectronAPI, testFlushAsync } from './scripted-graph'
import { testReadTimelineDone, type TestSeedResult } from './timeline-matrix'

export interface DriveStep {
  action: 'run' | 'continue'
  runPhase: MapSnapshot['runPhase']
  status?: 'interrupted' | 'done'
  transitionKey?: string
  pendingTool?: string
}

export interface DriveResult {
  log: DriveStep[]
  snapshot: MapSnapshot
}

export function testBuildMapApi(seed: TestSeedResult): MapAPI {
  mockMapReset()
  mockMapSeed(seed.display)
  const electron = testBuildScriptedElectronAPI({ seed })
  electron.map = mockMapBuildAPI()
  return adapterBuildIpc(electron)
}

function testReadClaims(mapId: string) {
  return mockMapRead(mapId)?.claims ?? []
}

/** 模拟 UI 点一次「继续」，并 flush 脚本图事件。 */
export async function testContinueOnce(mapApi: MapAPI, mapId: string): Promise<MapSnapshot> {
  await mapApi.continueStep(mapId)
  await testFlushAsync()
  return mapApi.getSnapshot(mapId)
}

/** HITL 单 transition：1 run + 3 continue（confirmRoute → validate → save）。 */
export async function testDriveHitlTransition(
  mapApi: MapAPI,
  mapId: string,
  mode: ExecutionMode = 'human-in-loop',
): Promise<DriveResult> {
  const log: DriveStep[] = []
  await testFlushAsync()
  const first = await mapApi.runTimeline(mapId, mode)
  await testFlushAsync()
  log.push({
    action: 'run',
    runPhase: first.snapshot.runPhase,
    status: first.status,
    transitionKey: first.snapshot.transitionKey,
    pendingTool: first.snapshot.pendingTool,
  })

  for (let i = 0; i < 3; i++) {
    const snap = await mapApi.getSnapshot(mapId)
    if (snap.runPhase !== 'interrupted') break
    log.push({
      action: 'continue',
      runPhase: 'interrupted',
      transitionKey: snap.transitionKey,
      pendingTool: snap.pendingTool,
    })
    await testContinueOnce(mapApi, mapId)
  }

  const snapshot = await mapApi.getSnapshot(mapId)
  return { log, snapshot }
}

/** 循环 run/continue 直到 testReadTimelineDone 或步数上限（集成探测用，主代码有 bug 时会快速失败）。 */
export async function testDriveTimelineToEnd(
  mapApi: MapAPI,
  mapId: string,
  endX: StateIndex,
  mode?: ExecutionMode,
  maxSteps = 40,
): Promise<DriveResult> {
  const log: DriveStep[] = []

  for (let i = 0; i < maxSteps; i++) {
    await testFlushAsync()
    const snap = await mapApi.getSnapshot(mapId)
    const claims = testReadClaims(mapId)

    if (snap.runPhase === 'interrupted') {
      log.push({
        action: 'continue',
        runPhase: 'interrupted',
        transitionKey: snap.transitionKey,
        pendingTool: snap.pendingTool,
      })
      await testContinueOnce(mapApi, mapId)
      continue
    }

    if (snap.runPhase === 'running') {
      await testFlushAsync()
      continue
    }

    const result = await mapApi.runTimeline(mapId, mode ?? snap.mode)
    log.push({
      action: 'run',
      runPhase: result.snapshot.runPhase,
      status: result.status,
      transitionKey: result.snapshot.transitionKey,
      pendingTool: result.snapshot.pendingTool,
    })
    await testFlushAsync()

    const afterClaims = testReadClaims(mapId)
    if (testReadTimelineDone(result.snapshot, afterClaims, endX)) {
      return { log, snapshot: result.snapshot }
    }

    if (result.status === 'interrupted') continue
  }

  const snapshot = await mapApi.getSnapshot(mapId)
  return { log, snapshot }
}

export function testCountActions(log: DriveStep[], action: DriveStep['action']): number {
  return log.filter(s => s.action === action).length
}
