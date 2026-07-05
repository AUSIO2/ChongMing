import { describe, expect, it } from 'vitest'
import { timelineReadPending } from '@flow-map/timeline'
import { mapIdCreateNews } from '@flow-map/ids'
import {
  testBuildMapApi,
  testContinueOnce,
  testCountActions,
  testDriveHitlTransition,
} from './fixtures/drive-timeline'
import { testBuildScriptedElectronAPI, testFlushAsync } from './fixtures/scripted-graph'
import { mockMapBuildAPI, mockMapReset, mockMapSeed } from './fixtures/mock-map-api'
import { testCreateSplitState } from './fixtures/graph-states'
import { testSeedMap, TEST_TIMELINE_WINDOWS } from './fixtures/timeline-matrix'

describe('test harness', () => {
  it('testSeedMap pending_source 含 mapGraph source', () => {
    const seed = testSeedMap('pending_source', { startX: 0, endX: 1 })
    expect(seed.sourceId).toBeTruthy()
    expect(seed.display.mapGraph?.nodes).toHaveLength(1)
    expect(seed.display.mapGraph?.nodes[0]?.kind).toBe('source')
  })

  it('testCreateSplitState 默认 mergedClaims', () => {
    const s = testCreateSplitState()
    expect(s.mergedClaims).toHaveLength(1)
    expect(s.mergedClaims[0]?.shouldSave).toBe(true)
  })

  it('scripted graph runTransition 发出 interrupt', async () => {
    const seed = testSeedMap('pending_source', { startX: 0, endX: 1 })
    mockMapReset()
    mockMapSeed(seed.display)
    const api = testBuildScriptedElectronAPI({ seed })
    api.map = mockMapBuildAPI()

    let hit = false
    api.events.onInterrupted(() => { hit = true })

    await api.graph.runTransition({
      mapId: seed.mapId,
      transitionKey: '0-1',
      parentNodeId: seed.sourceId!,
      mode: 'human-in-loop',
    })
    await testFlushAsync()
    expect(hit).toBe(true)
  })

  it('TEST_TIMELINE_WINDOWS 共 10 个合法窗口', () => {
    expect(TEST_TIMELINE_WINDOWS).toHaveLength(10)
  })
})

describe('flow integration（adapter + scripted graph，主代码有 bug 时可能失败）', () => {
  it('0-1 run 后应 interrupted @ confirmRoute', async () => {
    const seed = testSeedMap('pending_source', { startX: 0, endX: 1 }, 'human-in-loop')
    const mapApi = testBuildMapApi(seed)
    await testFlushAsync()
    const result = await mapApi.runTimeline(seed.mapId, 'human-in-loop')
    await testFlushAsync()
    expect(result.status).toBe('interrupted')
    expect(result.snapshot.pendingTool).toBe('invoke')
    expect(result.snapshot.runPhase).toBe('interrupted')
  })

  it('0-1 HITL 单 transition：1 run + 3 continue', async () => {
    const seed = testSeedMap('pending_source', { startX: 0, endX: 1 }, 'human-in-loop')
    const mapApi = testBuildMapApi(seed)
    const { log } = await testDriveHitlTransition(mapApi, seed.mapId)
    expect(testCountActions(log, 'run')).toBe(1)
    expect(testCountActions(log, 'continue')).toBe(3)
  })

  it('0-1 完成后 snapshot 应含 news（脚本状态投影）', async () => {
    const seed = testSeedMap('pending_source', { startX: 0, endX: 1 }, 'human-in-loop')
    const mapApi = testBuildMapApi(seed)
    const { snapshot } = await testDriveHitlTransition(mapApi, seed.mapId)
    const newsId = mapIdCreateNews(seed.chainId!)
    expect(snapshot.nodes.some(n => n.id === newsId && n.kind === 'news')).toBe(true)
  })

  it('1-2 run 后应 interrupted', async () => {
    const seed = testSeedMap('default_news', { startX: 1, endX: 2 }, 'human-in-loop')
    const mapApi = testBuildMapApi(seed)
    await testFlushAsync()
    const result = await mapApi.runTimeline(seed.mapId, 'human-in-loop')
    await testFlushAsync()
    expect(result.status).toBe('interrupted')
    expect(result.snapshot.runPhase).toBe('interrupted')
    expect(result.snapshot.pendingTool).toBeTruthy()
  })

  it('1-2 HITL 单 transition 后应有 claim 草稿或 persisted', async () => {
    const seed = testSeedMap('default_news', { startX: 1, endX: 2 }, 'human-in-loop')
    const mapApi = testBuildMapApi(seed)
    const { snapshot } = await testDriveHitlTransition(mapApi, seed.mapId)
    expect(snapshot.nodes.some(n => n.kind === 'claim')).toBe(true)
  })

  it('auto 1-2 无 continue', async () => {
    const seed = testSeedMap('default_news', { startX: 1, endX: 2 }, 'auto')
    const mapApi = testBuildMapApi(seed)
    await testFlushAsync()
    const result = await mapApi.runTimeline(seed.mapId, 'auto')
    await testFlushAsync()
    expect(result.status).toBe('done')
    const snap = await mapApi.getSnapshot(seed.mapId)
    expect(snap.runPhase).toBe('idle')
  })

  it('continueStep 仅在 interrupted 态推进', async () => {
    const seed = testSeedMap('default_news', { startX: 1, endX: 2 }, 'human-in-loop')
    const mapApi = testBuildMapApi(seed)
    const idle = await mapApi.getSnapshot(seed.mapId)
    expect(idle.runPhase).toBe('idle')
    const after = await testContinueOnce(mapApi, seed.mapId)
    expect(after.runPhase).toBe('idle')
  })

  it('seed 图对 schedule 可读 pending', async () => {
    const seed = testSeedMap('pending_source', { startX: 0, endX: 1 })
    const mapApi = testBuildMapApi(seed)
    const snap = await mapApi.getSnapshot(seed.mapId)
    expect(timelineReadPending(snap, [], '0-1').length).toBe(1)
  })
})
