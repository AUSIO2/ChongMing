import {
  MAP_DEFAULT_NEWS_ID,
  mapIdCreateChain,
  mapIdCreateNews,
  mapIdCreateSource,
} from '@flow-map/ids'
import { timelineCreateDefault, timelineDeriveStateIndex, timelineReadPending, timelineResolveKeys } from '@flow-map/timeline'
import type { DisplayClaim, DisplayMap } from '../../../electron/api/types'
import type { ExecutionMode, MapSnapshot } from '@flow-map/types'
import type { StateIndex, TransitionKey } from '@flow-map/timeline'

export const TEST_TIMELINE_WINDOWS = [
  { startX: 0, endX: 0, keys: [] as TransitionKey[] },
  { startX: 0, endX: 1, keys: ['0-1'] as TransitionKey[] },
  { startX: 0, endX: 2, keys: ['0-1', '1-2'] as TransitionKey[] },
  { startX: 0, endX: 3, keys: ['0-1', '1-2', '2-3'] as TransitionKey[] },
  { startX: 1, endX: 1, keys: [] as TransitionKey[] },
  { startX: 1, endX: 2, keys: ['1-2'] as TransitionKey[] },
  { startX: 1, endX: 3, keys: ['1-2', '2-3'] as TransitionKey[] },
  { startX: 2, endX: 2, keys: [] as TransitionKey[] },
  { startX: 2, endX: 3, keys: ['2-3'] as TransitionKey[] },
  { startX: 3, endX: 3, keys: [] as TransitionKey[] },
] as const

export type TestRootFixture =
  | 'pending_source'
  | 'multi_source'
  | 'default_news'
  | 'scoped_news'
  | 'multi_news'
  | 'scoped_claim'
  | 'default_claim'

export interface TestMatrixScenario {
  id: string
  window: { startX: StateIndex; endX: StateIndex }
  rootFixture: TestRootFixture
  mode: ExecutionMode
  expectedContinues: number
  expectedRuns: number
}

export interface TestSeedResult {
  mapId: string
  display: DisplayMap
  chainId?: string
  sourceId?: string
  newsId?: string
  claimId?: string
  claims: DisplayClaim[]
}

export function testSeedMap(
  fixture: TestRootFixture,
  window: { startX: StateIndex; endX: StateIndex },
  mode: ExecutionMode = 'human-in-loop',
): TestSeedResult {
  const mapId = `test-${fixture}-${window.startX}-${window.endX}`
  const timeline = timelineCreateDefault()
  timeline.startX = window.startX
  timeline.endX = window.endX

  const base: DisplayMap = {
    _id: mapId,
    content: 'hello',
    context: {},
    claims: [],
    timeline,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  if (fixture === 'pending_source') {
    const chainId = mapIdCreateChain()
    const sourceId = mapIdCreateSource(chainId)
    return {
      mapId,
      display: base,
      chainId,
      sourceId,
      claims: [],
      ...testApplySourceOnly(base, sourceId, mode),
    }
  }

  if (fixture === 'multi_source') {
    const chainA = mapIdCreateChain()
    const chainB = mapIdCreateChain()
    const sourceA = mapIdCreateSource(chainA)
    const sourceB = mapIdCreateSource(chainB)
    return {
      mapId,
      display: {
        ...base,
        mapGraph: {
          nodes: [
            { id: sourceA, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
            { id: sourceB, kind: 'source', params: { uri: '/b.txt', kind: 'file' } },
          ],
          edges: [],
          runPhase: 'idle',
          mode,
          updatedAt: new Date().toISOString(),
        },
      },
      claims: [],
    }
  }

  if (fixture === 'default_news') {
    return {
      mapId,
      display: {
        ...base,
        mapGraph: {
          nodes: [{ id: MAP_DEFAULT_NEWS_ID, kind: 'news', params: { content: '正文' } }],
          edges: [],
          runPhase: 'idle',
          mode,
          updatedAt: new Date().toISOString(),
        },
      },
      newsId: MAP_DEFAULT_NEWS_ID,
      claims: [],
    }
  }

  if (fixture === 'scoped_news') {
    const chainId = mapIdCreateChain()
    const sourceId = mapIdCreateSource(chainId)
    const newsId = mapIdCreateNews(chainId)
    return {
      mapId,
      display: {
        ...base,
        timeline: { ...timeline, activeScope: newsId },
        mapGraph: {
          nodes: [
            { id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
            { id: newsId, kind: 'news', params: { content: '正文' } },
          ],
          edges: [],
          runPhase: 'idle',
          mode,
          updatedAt: new Date().toISOString(),
        },
      },
      chainId,
      sourceId,
      newsId,
      claims: [],
    }
  }

  if (fixture === 'multi_news') {
    const newsA = mapIdCreateNews(mapIdCreateChain())
    const newsB = mapIdCreateNews(mapIdCreateChain())
    return {
      mapId,
      display: {
        ...base,
        timeline: { ...timeline, activeScope: newsA },
        mapGraph: {
          nodes: [
            { id: newsA, kind: 'news', params: { content: 'A' } },
            { id: newsB, kind: 'news', params: { content: 'B' } },
          ],
          edges: [],
          runPhase: 'idle',
          mode,
          updatedAt: new Date().toISOString(),
        },
      },
      newsId: newsA,
      claims: [],
    }
  }

  if (fixture === 'default_claim') {
    const claimId = '3'
    const claims: DisplayClaim[] = [{
      claimId,
      content: 'c1',
      category: undefined,
      sourceAgent: '数据事实',
    }]
    return {
      mapId,
      display: {
        ...base,
        claims,
        mapGraph: {
          nodes: [
            { id: MAP_DEFAULT_NEWS_ID, kind: 'news', params: { content: '正文' } },
            {
              id: claimId,
              kind: 'claim',
              parentId: MAP_DEFAULT_NEWS_ID,
              dataPhase: 'persisted',
              shouldSave: true,
              params: { content: 'c1', sourceAgent: '数据事实' },
            },
          ],
          edges: [],
          runPhase: 'idle',
          mode,
          updatedAt: new Date().toISOString(),
        },
      },
      newsId: MAP_DEFAULT_NEWS_ID,
      claimId,
      claims,
    }
  }

  // scoped_claim
  const chainId = mapIdCreateChain()
  const newsId = mapIdCreateNews(chainId)
  const subId = `sub:${newsId}:数据事实#1`
  const claimId = `claim:news:${chainId}:1`
  const claims: DisplayClaim[] = [{
    claimId,
    content: 'c1',
    sourceAgent: '数据事实',
  }]
  return {
    mapId,
    display: {
      ...base,
      claims,
      timeline: { ...timeline, activeScope: newsId },
      mapGraph: {
        nodes: [
          { id: newsId, kind: 'news', params: { content: '正文' } },
          {
            id: subId,
            kind: 'subAgent',
            parentId: newsId,
            params: { agentName: '数据事实', priority: 'medium', instanceId: '数据事实#1' },
          },
          {
            id: claimId,
            kind: 'claim',
            parentId: subId,
            dataPhase: 'persisted',
            shouldSave: true,
            params: { content: 'c1', sourceAgent: '数据事实' },
          },
        ],
        edges: [],
        runPhase: 'idle',
        mode,
        updatedAt: new Date().toISOString(),
      },
    },
    chainId,
    newsId,
    claimId,
    claims,
  }
}

function testApplySourceOnly(
  base: DisplayMap,
  sourceId: string,
  mode: ExecutionMode = 'human-in-loop',
): Pick<TestSeedResult, 'display'> {
  return {
    display: {
      ...base,
      mapGraph: {
        nodes: [{ id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } }],
        edges: [],
        runPhase: 'idle',
        mode,
        updatedAt: new Date().toISOString(),
      },
    },
  }
}

export function testReadTimelineDone(
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
  endX: StateIndex,
): boolean {
  if (snapshot.runPhase !== 'idle') return false

  const derived = timelineDeriveStateIndex(snapshot, claims, snapshot.timeline)
  if (derived < endX) return false

  const keys = timelineResolveKeys(snapshot.timeline, derived)
  for (const key of keys) {
    if (timelineReadPending(snapshot, claims, key).length > 0) return false
  }

  if (endX >= 2 && !snapshot.nodes.some(n => n.kind === 'claim' && n.dataPhase === 'persisted')) {
    return false
  }
  if (endX >= 3 && !snapshot.nodes.some(n => n.kind === 'opinion' && n.dataPhase === 'persisted')) {
    return false
  }
  if (endX >= 1 && !snapshot.nodes.some(n => n.kind === 'news' && n.params.content.trim())) {
    return false
  }
  return true
}
