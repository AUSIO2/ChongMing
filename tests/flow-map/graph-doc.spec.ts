import { describe, expect, it } from 'vitest'
import { MAP_DEFAULT_NEWS_ID, mapIdCreateSource, mapIdCreateParse, mapIdCreateNews, mapIdCreateDraftClaim } from '@flow-map/ids'
import type { MapSnapshot, MapClaimNode } from '@flow-map/types'
import { timelineCreateDefault } from '@flow-map/timeline'
import {
  docUpdateInterrupt,
  docUpdateProgress,
  docProjectGraphState,
  docCreateMap,
  docReadResume,
  docCanAddSubAgent,
  docCanEditNode,
  docCanRemoveNode,
  docCreate,
  docUpdateSubAgent,
  docIsParamLock,
  docDeleteClaims,
  docResetMap,
  docUpdateDraft,
  docReadRoutes,
  docAddRootNews,
  docAddRootClaim,
  docReconcileVerify,
  docDedupClaims,
  docBatchUpdateSubAgents,
  type MapGraphDoc,
} from '@flow-map/graph-doc'
import type { DisplayMap, GraphInterruptedPayload, GraphSplitState } from '../../electron/api/types'

function baseSnapshot(overrides: Partial<MapSnapshot> = {}): MapSnapshot {
  return {
    mapId: 'n1',
    nodes: [],
    edges: [],
    runPhase: 'idle',
    mode: 'human-in-loop',
    timeline: timelineCreateDefault(),
    ...overrides,
  }
}

describe('graph-doc capability', () => {
  it('idle news 无槽：正文可编、route 可预置', () => {
    const snap = baseSnapshot({
      nodes: [
        {
          id: MAP_DEFAULT_NEWS_ID,
          kind: 'news',
          params: { content: '' },
        },
      ],
    })
    expect(docCanAddSubAgent(snap, MAP_DEFAULT_NEWS_ID)).toBe(true)
    expect(docIsParamLock(snap, snap.nodes[0])).toBe(false)
  })

  it('news 有 subAgent 无 claim：正文锁、route 仍可配', () => {
    const news = {
      id: MAP_DEFAULT_NEWS_ID,
      kind: 'news' as const,
      params: { content: 'x' },
    }
    const sa = {
      id: 'sub:x',
      kind: 'subAgent' as const,
      parentId: MAP_DEFAULT_NEWS_ID,
      params: { agentName: 'a', priority: 'medium' as const, instanceId: 'a' },
    }
    const snap = baseSnapshot({ nodes: [news, sa] })
    expect(docIsParamLock(snap, news)).toBe(true)
    expect(docCanAddSubAgent(snap, MAP_DEFAULT_NEWS_ID)).toBe(true)
  })

  it('running 仅锁 active scope 子树', () => {
    const newsA = { id: MAP_DEFAULT_NEWS_ID, kind: 'news' as const, params: { content: 'a' } }
    const newsB = { id: 'news:chain:b', kind: 'news' as const, params: { content: 'b' } }
    const snap = baseSnapshot({
      runPhase: 'running',
      activeNodeId: MAP_DEFAULT_NEWS_ID,
      timeline: { ...timelineCreateDefault(MAP_DEFAULT_NEWS_ID), activeScope: MAP_DEFAULT_NEWS_ID },
      nodes: [newsA, newsB],
    })
    expect(docIsParamLock(snap, newsA)).toBe(true)
    expect(docIsParamLock(snap, newsB)).toBe(false)
  })

  it('interrupted 不全局锁 news 正文（无工艺后代时）', () => {
    const news = {
      id: MAP_DEFAULT_NEWS_ID,
      kind: 'news' as const,
      params: { content: 'x' },
    }
    expect(docIsParamLock(
      baseSnapshot({ runPhase: 'interrupted', pendingTool: 'invoke', nodes: [news] }),
      news,
    )).toBe(false)
  })

  it('running 禁止 route；idle 允许', () => {
    const news = { id: MAP_DEFAULT_NEWS_ID, kind: 'news' as const, params: { content: '' } }
    expect(docCanAddSubAgent(
      baseSnapshot({
        runPhase: 'running',
        activeNodeId: MAP_DEFAULT_NEWS_ID,
        timeline: { ...timelineCreateDefault(MAP_DEFAULT_NEWS_ID), activeScope: MAP_DEFAULT_NEWS_ID },
        nodes: [news],
      }),
      MAP_DEFAULT_NEWS_ID,
    )).toBe(false)
    expect(docCanAddSubAgent(baseSnapshot({ nodes: [news] }), MAP_DEFAULT_NEWS_ID)).toBe(true)
  })

  it('persisted claim 无 opinion 时可配核查 route', () => {
    const claim: MapSnapshot['nodes'][number] = {
      id: '1',
      kind: 'claim',
      params: { content: 'c' },
      dataPhase: 'persisted',
      shouldSave: true,
    }
    expect(docCanAddSubAgent(baseSnapshot({ nodes: [claim] }), '1')).toBe(true)
    expect(docCanAddSubAgent(
      baseSnapshot({
        runPhase: 'running',
        activeNodeId: '1',
        timeline: { ...timelineCreateDefault(), activeScope: '1' },
        nodes: [claim],
      }),
      '1',
    )).toBe(false)
  })

  it('禁止把核查 subAgent 挂到 workerOut claim 上', () => {
    const claim: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'workerOut',
      shouldSave: true,
    }
    expect(docCanAddSubAgent(baseSnapshot({ nodes: [claim] }), 'claim:x:0')).toBe(false)
  })

  it('claim 一旦离开 workerOut 就锁定参数；opinion 始终锁定', () => {
    const workerOut: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'workerOut',
      shouldSave: true,
    }
    const persisted = { ...workerOut, dataPhase: 'persisted' as const }
    const opinion: MapSnapshot['nodes'][number] = {
      id: 'opinion:x:0',
      kind: 'opinion',
      parentId: 'sub:x',
      params: { content: 'o', confidence: 1, priority: 'medium' },
      dataPhase: 'workerOut',
    }
    const snap = baseSnapshot({ nodes: [workerOut, persisted, opinion] })
    expect(docIsParamLock(snap, workerOut)).toBe(false)
    expect(docIsParamLock(snap, persisted)).toBe(true)
    expect(docIsParamLock(snap, opinion)).toBe(true)
  })

  it('subAgent 只要下游有产出就锁定，即使产出仍处于 workerOut', () => {
    const sa: MapSnapshot['nodes'][number] = {
      id: 'sub:x',
      kind: 'subAgent',
      params: { agentName: 'a', priority: 'medium', instanceId: 'a' },
    }
    const child: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'workerOut',
      shouldSave: true,
    }
    const snap = baseSnapshot({ nodes: [sa, child] })
    expect(docIsParamLock(snap, sa)).toBe(true)
    expect(docCanEditNode(snap, sa.id)).toBe(false)
    expect(docCanEditNode(snap, child.id)).toBe(true)
  })

  it('news 有 claim 后 route 锁', () => {
    const news = { id: MAP_DEFAULT_NEWS_ID, kind: 'news' as const, params: { content: 'x' } }
    const sa = {
      id: 'sub:x',
      kind: 'subAgent' as const,
      parentId: MAP_DEFAULT_NEWS_ID,
      params: { agentName: 'a', priority: 'medium' as const, instanceId: 'a' },
    }
    const claim: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'workerOut',
      shouldSave: true,
    }
    const snap = baseSnapshot({ nodes: [news, sa, claim] })
    expect(docCanAddSubAgent(snap, MAP_DEFAULT_NEWS_ID)).toBe(false)
  })

  it('idle 可删除无下游 subAgent 槽', () => {
    const sa: MapSnapshot['nodes'][number] = {
      id: 'sub:x',
      kind: 'subAgent',
      parentId: MAP_DEFAULT_NEWS_ID,
      params: { agentName: 'a', priority: 'medium', instanceId: 'a' },
    }
    const news = { id: MAP_DEFAULT_NEWS_ID, kind: 'news' as const, params: { content: '' } }
    expect(docCanRemoveNode(baseSnapshot({ nodes: [news, sa] }), sa.id)).toBe(true)

    const child: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: sa.id,
      params: { content: 'c' },
      dataPhase: 'workerOut',
      shouldSave: true,
    }
    expect(docCanRemoveNode(
      baseSnapshot({ nodes: [news, sa, child] }),
      sa.id,
    )).toBe(false)
  })
})

function emptyMap(id = 'n1'): DisplayMap {
  return {
    _id: id,
    content: 'hello',
    context: {},
    claims: [],
    timeline: { startX: 0, endX: 3, activeScope: MAP_DEFAULT_NEWS_ID },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function splitState(overrides: Partial<GraphSplitState> = {}): GraphSplitState {
  return {
    mapId: 'n1',
    parentNodeId: MAP_DEFAULT_NEWS_ID,
    mode: 'human-in-loop',
    content: 'hello',
    visibleContext: {},
    routeInstructions: [{ agentName: 'a', priority: 'medium', instanceId: 'a' }],
    subAgentResults: [{
      agentName: 'a',
      priority: 'medium',
      instanceId: 'a',
      claims: [
        { content: 'c1', sourceAgent: 'a' },
        { content: 'c2', sourceAgent: 'a' },
      ],
      rawResponse: '',
    }],
    mergedClaims: [
      { content: 'c1', sourceAgent: 'a', shouldSave: true },
      { content: 'c2', sourceAgent: 'a', shouldSave: false },
    ],
    rawMergeResponse: '',
    saveIndex: 0,
    ...overrides,
  }
}

describe('graph-doc state', () => {
  it('docResetMap 清空 runId / draft / transitionKey / focus', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    doc.transitionKey = '1-2'
    doc.draft = splitState()
    doc.activeNodeId = MAP_DEFAULT_NEWS_ID
    doc.pendingTool = 'validate'
    doc.error = 'x'
    docResetMap(doc, emptyMap())
    expect(doc.runPhase).toBe('idle')
    expect(doc.runId).toBeUndefined()
    expect(doc.transitionKey).toBeUndefined()
    expect(doc.draft).toBeUndefined()
    expect(doc.activeNodeId).toBeUndefined()
    expect(doc.pendingTool).toBeUndefined()
    expect(doc.error).toBeUndefined()
    expect(doc.nodes.some(n => n.kind === 'news')).toBe(true)
  })

  it('docUpdateProgress 在焦点上挂 activeTool，并清 snapshot pendingTool', () => {
    const doc = docCreate('n1')
    doc.nodes = [{ id: MAP_DEFAULT_NEWS_ID, kind: 'news', params: { content: 'x' } }]
    doc.runPhase = 'interrupted'
    doc.runId = 'run-1'
    doc.activeNodeId = MAP_DEFAULT_NEWS_ID
    doc.pendingTool = 'validate'
    doc.nodes[0].runtime = { pendingTool: 'validate' }

    docUpdateProgress(doc, {
      runId: 'run-1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      event: 'node_enter',
      node: '',
    })
    expect(doc.runPhase).toBe('running')
    expect(doc.pendingTool).toBeUndefined()
    expect(doc.activeNodeId).toBe(MAP_DEFAULT_NEWS_ID)
    expect(doc.nodes[0].runtime).toEqual({ activeTool: 'validate' })
  })

  it('docReadResume 只认 pendingTool', () => {
    const doc = docCreate('n1')
    doc.draft = splitState()
    doc.pendingTool = 'invoke'
    expect(docReadResume(doc)).toEqual({
      routeInstructions: doc.draft.routeInstructions,
    })

    doc.pendingTool = 'validate'
    const draftClaims = (doc.draft as GraphSplitState).mergedClaims
    const validatePatch = docReadResume(doc)
    expect(validatePatch && 'mergedClaims' in validatePatch && validatePatch.mergedClaims).toEqual(
      draftClaims,
    )

    doc.pendingTool = 'save'
    const savePatch = docReadResume(doc)
    expect(savePatch && 'mergedClaims' in savePatch && savePatch.mergedClaims).toHaveLength(2)

    doc.pendingTool = undefined
    expect(docReadResume(doc)).toBeNull()
  })

  it('validate 投影只改 shouldSave；prune 后 sync 不含被拒草稿', () => {
    const state = splitState()
    const payload: GraphInterruptedPayload = {
      runId: 'r1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      nextNode: 'validate',
      mode: 'human-in-loop',
      state,
      focus: { kind: 'news', id: MAP_DEFAULT_NEWS_ID },
      pendingTool: 'validate',
    }
    const doc = docCreate('n1')
    docUpdateInterrupt(doc, payload)

    const drafts = doc.nodes.filter(n => n.kind === 'claim')
    expect(drafts).toHaveLength(2)
    expect(drafts[0].shouldSave).toBe(true)
    expect(drafts[1].shouldSave).toBe(false)
    expect(drafts[0].params.content).toBe('c1')
    expect(drafts[1].params.content).toBe('c2')

    docDeleteClaims(doc)
    expect(doc.nodes.filter(n => n.kind === 'claim')).toHaveLength(1)
    expect(doc.nodes.find(n => n.kind === 'claim')?.params.content).toBe('c1')

    docUpdateDraft(doc)
    expect(doc.draft && 'mergedClaims' in doc.draft && doc.draft.mergedClaims).toEqual([
      { content: 'c1', category: undefined, sourceAgent: 'a', shouldSave: true },
    ])
  })

  it('scoped news 拆分中断保留源链', () => {
    const chainId = '7f2bd485'
    const sourceId = mapIdCreateSource(chainId)
    const parseId = mapIdCreateParse(chainId)
    const newsId = mapIdCreateNews(chainId)
    const doc = docCreate('n1')
    doc.nodes = [
      { id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
      { id: parseId, kind: 'parseAgent', parentId: sourceId, params: { agentName: 'parse' } },
      { id: newsId, kind: 'news', parentId: parseId, params: { content: '正文' } },
    ]
    doc.edges = [
      { id: 'e1', from: sourceId, to: parseId },
      { id: 'e2', from: parseId, to: newsId },
    ]

    docUpdateInterrupt(doc, {
      runId: 'r1',
      mapId: 'n1',
      parentNodeId: newsId,
      transitionKey: '1-2',
      nextNode: 'confirmRoute',
      mode: 'human-in-loop',
      state: splitState({
        parentNodeId: newsId,
        content: '正文',
        routeInstructions: [
          { agentName: '数据事实', priority: 'medium', instanceId: '数据事实#1' },
        ],
        subAgentResults: [],
        mergedClaims: [],
      }),
      focus: { kind: 'news', id: newsId },
      pendingTool: 'invoke',
    })

    expect(doc.nodes.some(n => n.kind === 'source')).toBe(true)
    expect(doc.nodes.some(n => n.kind === 'parseAgent')).toBe(true)
    expect(doc.nodes.find(n => n.id === newsId)?.kind).toBe('news')
    expect(doc.nodes.some(n => n.kind === 'subAgent' && n.parentId === newsId)).toBe(true)
  })

  it('scoped news validate 中断保留 subAgent（空 routeInstructions 不 prune）', () => {
    const newsId = mapIdCreateNews('a1b2c3d4')
    const doc = docCreate('n1')
    doc.nodes = [{ id: newsId, kind: 'news', params: { content: '正文' } }]

    docUpdateInterrupt(doc, {
      runId: 'r1',
      mapId: 'n1',
      parentNodeId: newsId,
      transitionKey: '1-2',
      nextNode: 'confirmRoute',
      mode: 'human-in-loop',
      state: splitState({
        parentNodeId: newsId,
        content: '正文',
        routeInstructions: [
          { agentName: '数据事实', priority: 'medium', instanceId: '数据事实#1' },
        ],
        subAgentResults: [],
        mergedClaims: [],
      }),
      focus: { kind: 'news', id: newsId },
      pendingTool: 'invoke',
    })
    expect(doc.nodes.filter(n => n.kind === 'subAgent' && n.parentId === newsId)).toHaveLength(1)

    docUpdateInterrupt(doc, {
      runId: 'r1',
      mapId: 'n1',
      parentNodeId: newsId,
      transitionKey: '1-2',
      nextNode: 'validate',
      mode: 'human-in-loop',
      state: splitState({
        parentNodeId: newsId,
        content: '正文',
        routeInstructions: [],
        subAgentResults: [],
        mergedClaims: [],
      }),
      focus: { kind: 'news', id: newsId },
      pendingTool: 'validate',
    })
    expect(doc.nodes.filter(n => n.kind === 'subAgent' && n.parentId === newsId)).toHaveLength(1)
  })

  it('verify 同名多槽：各挂一条 opinion，不合并到同一 subAgent', () => {
    const claimId = '2'
    const doc = docCreate('n1')
    doc.nodes = [
      { id: MAP_DEFAULT_NEWS_ID, kind: 'news', params: { content: 'x' } },
      {
        id: claimId,
        kind: 'claim',
        parentId: MAP_DEFAULT_NEWS_ID,
        params: { content: 'c' },
        dataPhase: 'persisted',
        shouldSave: true,
      },
    ]
    const payload: GraphInterruptedPayload = {
      runId: 'r1',
      mapId: 'n1',
      parentNodeId: claimId,
      transitionKey: '2-3',
      nextNode: 'save',
      mode: 'human-in-loop',
      focus: { kind: 'opinion', id: 'opinion:2:0' },
      pendingTool: 'save',
      state: {
        mapId: 'n1',
        parentNodeId: claimId,
        scopeNodeId: MAP_DEFAULT_NEWS_ID,
        mode: 'human-in-loop',
        claimContent: 'c',
        originalContent: 'x',
        visibleContext: {},
        routeInstructions: [
          { agentName: '来源可信度', priority: 'medium', instanceId: '来源可信度#1' },
          { agentName: '来源可信度', priority: 'high', instanceId: '来源可信度#2' },
        ],
        subAgentOpinions: [
          {
            agentName: '来源可信度',
            instanceId: '来源可信度#1',
            priority: 'medium',
            score: 1,
            reason: 'op1',
            rawResponse: '',
          },
          {
            agentName: '来源可信度',
            instanceId: '来源可信度#2',
            priority: 'high',
            score: 0,
            reason: 'op2',
            rawResponse: '',
          },
        ],
        finalScore: 0.5,
        finalReason: '',
        rawMergeResponse: '',
        opinionSaveIndex: 0,
      },
    }
    docUpdateInterrupt(doc, payload)

    const subs = doc.nodes.filter(n => n.kind === 'subAgent' && n.parentId === claimId)
    expect(subs).toHaveLength(2)
    const opinions = doc.nodes.filter(n => n.kind === 'opinion')
    expect(opinions).toHaveLength(2)
    const parents = new Set(opinions.map(o => o.parentId))
    expect(parents.size).toBe(2)
    expect(parents).toEqual(new Set(subs.map(s => s.id)))
  })

  it('auto：save 节点执行后 docProjectGraphState 投影全部 persisted opinion', () => {
    const claimId = '3'
    const doc = docCreate('n1')
    doc.nodes = [
      { id: MAP_DEFAULT_NEWS_ID, kind: 'news', params: { content: 'x' } },
      {
        id: claimId,
        kind: 'claim',
        parentId: MAP_DEFAULT_NEWS_ID,
        params: { content: 'c' },
        dataPhase: 'persisted',
        shouldSave: true,
      },
    ]
    docProjectGraphState(doc, '2-3', {
      mapId: 'n1',
      parentNodeId: claimId,
      scopeNodeId: MAP_DEFAULT_NEWS_ID,
      mode: 'auto',
      claimContent: 'c',
      originalContent: 'x',
      visibleContext: {},
      routeInstructions: [
        { agentName: '来源可信度', priority: 'high', instanceId: '来源可信度#1' },
        { agentName: '数据可验证性', priority: 'high', instanceId: '数据可验证性#1' },
        { agentName: '逻辑一致性', priority: 'medium', instanceId: '逻辑一致性#1' },
      ],
      subAgentOpinions: [
        { agentName: '来源可信度', instanceId: '来源可信度#1', priority: 'high', score: 1, reason: 'r1', rawResponse: '' },
        { agentName: '数据可验证性', instanceId: '数据可验证性#1', priority: 'high', score: 1, reason: 'r2', rawResponse: '' },
        { agentName: '逻辑一致性', instanceId: '逻辑一致性#1', priority: 'medium', score: 1, reason: 'r3', rawResponse: '' },
      ],
      finalScore: 1,
      finalReason: 'merged',
      rawMergeResponse: '',
      opinionSaveIndex: 3,
    }, { completedNode: 'save' })

    const opinions = doc.nodes.filter(
      n => n.kind === 'opinion' && n.id.startsWith(`opinion:${claimId}:`),
    )
    expect(opinions).toHaveLength(3)
    for (const o of opinions) {
      expect(o.kind).toBe('opinion')
      if (o.kind === 'opinion') {
        expect(o.dataPhase).toBe('persisted')
      }
    }
    expect(
      opinions.map(o => (o.kind === 'opinion' ? o.params.content : '')),
    ).toEqual(['r1', 'r2', 'r3'])
  })

  it('docUpdateSubAgent 核查：不同 claim 同 instanceId 不共用节点', () => {
    const doc = docCreate('n1')
    doc.nodes = [
      { id: MAP_DEFAULT_NEWS_ID, kind: 'news', params: { content: '' } },
      { id: '1', kind: 'claim', parentId: MAP_DEFAULT_NEWS_ID, params: { content: 'c1' }, dataPhase: 'persisted', shouldSave: true },
      { id: '2', kind: 'claim', parentId: MAP_DEFAULT_NEWS_ID, params: { content: 'c2' }, dataPhase: 'persisted', shouldSave: true },
    ]
    const route = { agentName: 'a', priority: 'medium' as const, instanceId: 'a#1' }
    const id1 = docUpdateSubAgent(doc, '1', route)
    const id2 = docUpdateSubAgent(doc, '2', route)
    expect(id1).toBe('sub:1:a#1')
    expect(id2).toBe('sub:2:a#1')
    expect(doc.nodes.filter(n => n.kind === 'subAgent')).toHaveLength(2)
  })

  it('docUpdateSubAgent 重复 id 更新 parent、边不重复', () => {
    const doc: MapGraphDoc = docCreate('n1')
    doc.nodes = [{ id: MAP_DEFAULT_NEWS_ID, kind: 'news', params: { content: '' } }]
    const id1 = docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: 'a',
      priority: 'medium',
      instanceId: 'a',
    })
    const id2 = docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a',
      hint: 'h',
    })
    expect(id1).toBe(id2)
    expect(doc.nodes.filter(n => n.kind === 'subAgent')).toHaveLength(1)
    expect(doc.edges.filter(e => e.to === id1)).toHaveLength(1)
    const sa = doc.nodes.find(n => n.id === id1)
    expect(sa?.kind === 'subAgent' && sa.params.priority).toBe('high')
    expect(sa?.kind === 'subAgent' && sa.params.hint).toBe('h')
  })

  it('docCreateMap 从 opinion / route 还原 SubAgent 槽', () => {
    const news = {
      _id: 'n1',
      content: 'body',
      context: {},
      claims: [{
        claimId: '1',
        content: 'fact',
        sourceAgent: 'data-claims',
        verifyResult: {
          score: 0.5,
          reason: 'ok',
          rawMergeResponse: '',
          verifiedAt: '2026-01-01T00:00:00.000Z',
          opinions: [{
            agentName: '来源可信度',
            instanceId: '来源可信度#1',
            priority: 'medium',
            score: 1,
            reason: '可信',
            rawResponse: '',
          }],
        },
      }],
      splitMeta: {
        model: 'langgraph',
        routeInstructions: [{
          agentName: 'data-claims',
          priority: 'high',
          instanceId: 'data-claims#1',
        }],
        subAgentResults: [],
        rawMergeResponse: '',
        splitAt: '2026-01-01T00:00:00.000Z',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      timeline: { startX: 0, endX: 3, activeScope: MAP_DEFAULT_NEWS_ID },
    } as DisplayMap

    const doc = docCreateMap(news)
    const sub = doc.nodes.find(n => n.kind === 'subAgent' && n.parentId === '1')
    expect(sub?.id).toBe('sub:1:来源可信度#1')
    expect(doc.nodes.some(n => n.kind === 'opinion')).toBe(true)
  })

  it('docReconcileVerify 从 chains 补齐缺失 opinion 节点', () => {
    const doc = docCreate('n1')
    doc.nodes.push({
      id: 'claim:news:a:1',
      kind: 'claim',
      parentId: 'news:a',
      params: { content: 'fact' },
      dataPhase: 'persisted',
      shouldSave: true,
    })
    docReconcileVerify(doc, [{
      claimId: 'claim:news:a:1',
      content: 'fact',
      verifyResult: {
        score: 1,
        reason: 'ok',
        rawMergeResponse: '',
        verifiedAt: '2026-01-01T00:00:00.000Z',
        opinions: [{
          agentName: '来源可信度',
          instanceId: '来源可信度#1',
          priority: 'medium',
          score: 1,
          reason: '可信',
          rawResponse: '',
        }],
      },
    }])
    expect(doc.nodes.some(n => n.kind === 'opinion')).toBe(true)
    expect(doc.nodes.some(n => n.kind === 'subAgent' && n.parentId === 'claim:news:a:1')).toBe(true)
  })

  it('subagent_tool start 写入 activeSkill（含 argsSummary）', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: '来源可信度',
      priority: 'high',
      instanceId: '来源可信度#1',
    })

    docUpdateProgress(doc, {
      runId: 'run-1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      event: 'subagent_tool',
      phase: 'start',
      nodeId: 'sub:来源可信度#1',
      toolName: 'web_search',
      argsSummary: '某新闻标题',
    })

    const sub = doc.nodes.find(n => n.id === 'sub:来源可信度#1')
    expect(sub?.runtime?.activeSkill).toEqual({
      name: 'web_search',
      argsSummary: '某新闻标题',
    })
    expect(doc.runPhase).toBe('running')
  })

  it('subagent_tool end 仅清除对应节点 activeSkill', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })
    docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: 'b',
      priority: 'medium',
      instanceId: 'b#1',
    })
    const subA = doc.nodes.find(n => n.id === 'sub:a#1')!
    const subB = doc.nodes.find(n => n.id === 'sub:b#1')!
    subA.runtime = { activeSkill: { name: 'web_search', argsSummary: 'q1' } }
    subB.runtime = { activeSkill: { name: 'web_search', argsSummary: 'q2' } }

    docUpdateProgress(doc, {
      runId: 'run-1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      event: 'subagent_tool',
      phase: 'end',
      nodeId: 'sub:a#1',
      toolName: 'web_search',
    })

    expect(subA.runtime).toBeUndefined()
    expect(subB.runtime?.activeSkill).toEqual({ name: 'web_search', argsSummary: 'q2' })
  })

  it('node_enter 不清除其他 SubAgent 的 activeSkill', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })
    docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: 'b',
      priority: 'medium',
      instanceId: 'b#1',
    })
    const subB = doc.nodes.find(n => n.id === 'sub:b#1')!
    subB.runtime = { activeSkill: { name: 'web_search', argsSummary: 'q2' } }

    docUpdateProgress(doc, {
      runId: 'run-1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      event: 'node_enter',
      node: 'subAgent',
    })

    expect(subB.runtime?.activeSkill).toEqual({ name: 'web_search', argsSummary: 'q2' })
  })

  it('node_exit subAgent 清除全部 activeSkill', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })
    const subA = doc.nodes.find(n => n.id === 'sub:a#1')!
    subA.runtime = { activeSkill: { name: 'web_search' } }

    docUpdateProgress(doc, {
      runId: 'run-1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      event: 'node_exit',
      node: 'subAgent',
    })

    expect(subA.runtime).toBeUndefined()
  })

  it('verify：subagent_tool 按 nodeId 匹配节点', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    doc.runPhase = 'running'
    doc.transitionKey = '2-3'
    doc.draft = {
      mapId: 'n1',
      parentNodeId: '1',
      scopeNodeId: MAP_DEFAULT_NEWS_ID,
      mode: 'human-in-loop',
      claimContent: 'c',
      originalContent: 'o',
      visibleContext: {},
      routeInstructions: [],
      subAgentOpinions: [],
      finalScore: 0.5,
      finalReason: '',
      rawMergeResponse: '',
      opinionSaveIndex: 0,
    }
    docUpdateSubAgent(doc, '1', {
      agentName: '来源可信度',
      priority: 'high',
      instanceId: '来源可信度#1',
    })

    docUpdateProgress(doc, {
      runId: 'run-1',
      mapId: 'n1',
      parentNodeId: '1',
      transitionKey: '2-3',
      event: 'subagent_tool',
      phase: 'start',
      nodeId: 'sub:1:来源可信度#1',
      toolName: 'web_search',
      argsSummary: 'query',
    })

    const sub = doc.nodes.find(n => n.id === 'sub:1:来源可信度#1')
    expect(sub?.runtime?.activeSkill).toEqual({
      name: 'web_search',
      argsSummary: 'query',
    })
  })

  it('fanout_spawn 在 auto 模式下创建 SubAgent 节点，subagent_tool 可写入 activeSkill', () => {
    const doc = docCreate('n1')
    doc.runPhase = 'running'
    doc.transitionKey = '1-2'
    doc.runId = 'run-1'

    docUpdateProgress(doc, {
      runId: 'run-1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      event: 'fanout_spawn',
      node: 'subAgent',
      agentName: '来源可信度',
      nodeId: 'sub:来源可信度#1',
      spawnIndex: 0,
    })

    expect(doc.nodes.some(n => n.id === 'sub:来源可信度#1')).toBe(true)

    docUpdateProgress(doc, {
      runId: 'run-1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      event: 'subagent_tool',
      phase: 'start',
      nodeId: 'sub:来源可信度#1',
      toolName: 'web_search',
      argsSummary: 'query',
    })

    const sub = doc.nodes.find(n => n.id === 'sub:来源可信度#1')
    expect(sub?.runtime?.activeSkill).toEqual({
      name: 'web_search',
      argsSummary: 'query',
    })
  })

  it('docUpdateProgress 忽略 runId 不匹配的 progress', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-a'
    doc.runPhase = 'running'
    docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })

    docUpdateProgress(doc, {
      runId: 'run-b',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      event: 'subagent_tool',
      phase: 'start',
      nodeId: 'sub:a#1',
      toolName: 'web_search',
    })

    const sub = doc.nodes.find(n => n.id === 'sub:a#1')
    expect(sub?.runtime?.activeSkill).toBeUndefined()
  })

  it('docUpdateProgress 在 completed 阶段忽略 progress', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    doc.runPhase = 'completed'
    docUpdateSubAgent(doc, MAP_DEFAULT_NEWS_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })

    docUpdateProgress(doc, {
      runId: 'run-1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      event: 'node_enter',
      node: 'subAgent',
    })

    expect(doc.runPhase).toBe('completed')
  })

  it('docUpdateInterrupt 同 gate 幂等', () => {
    const doc = docCreate('n1')
    const payload: GraphInterruptedPayload = {
      runId: 'r1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      nextNode: 'validate',
      mode: 'human-in-loop',
      state: splitState(),
      focus: { kind: 'news', id: MAP_DEFAULT_NEWS_ID },
      pendingTool: 'validate',
    }
    docUpdateInterrupt(doc, payload)
    const nodeCount = doc.nodes.length
    docUpdateInterrupt(doc, payload)
    expect(doc.nodes.length).toBe(nodeCount)
  })

  it('save 中断投影 numbered claims，saveIndex 区分 persisted', () => {
    const state = splitState({
      saveIndex: 1,
      mergedClaims: [
        { content: 'c1', sourceAgent: 'a', shouldSave: true },
        { content: 'c2', sourceAgent: 'a', shouldSave: true },
      ],
    })
    const doc = docCreate('n1')
    doc.nodes.push(
      { id: 'draft:0', kind: 'claim', parentId: MAP_DEFAULT_NEWS_ID, params: { content: 'c1', sourceAgent: 'a' }, dataPhase: 'workerOut', shouldSave: true },
      { id: 'draft:1', kind: 'claim', parentId: MAP_DEFAULT_NEWS_ID, params: { content: 'c2', sourceAgent: 'a' }, dataPhase: 'workerOut', shouldSave: true },
    )
    docUpdateInterrupt(doc, {
      runId: 'r1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      nextNode: 'save',
      mode: 'human-in-loop',
      state,
      focus: { kind: 'news', id: MAP_DEFAULT_NEWS_ID },
      pendingTool: 'save',
    })
    const claims = doc.nodes.filter(n => n.kind === 'claim')
    expect(claims.map(c => c.id)).toEqual(['1', '2'])
    expect(claims[0]?.dataPhase).toBe('persisted')
    expect(claims[1]?.dataPhase).toBe('workerOut')
    expect(claims.every(c => c.shouldSave)).toBe(true)
  })

  it('invoke 中断无 subAgentResults 时不建 draft claim', () => {
    const state = splitState({
      subAgentResults: [],
      mergedClaims: [],
    })
    const doc = docCreate('n1')
    docUpdateInterrupt(doc, {
      runId: 'r1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      nextNode: 'confirmRoute',
      mode: 'human-in-loop',
      state,
      focus: { kind: 'news', id: MAP_DEFAULT_NEWS_ID },
      pendingTool: 'invoke',
    })
    expect(doc.nodes.filter(n => n.kind === 'claim')).toHaveLength(0)
    expect(doc.nodes.filter(n => n.kind === 'subAgent')).toHaveLength(1)
  })

  it('split 同名多槽：draft claim 挂到对应 instanceId 的 subAgent', () => {
    const state = splitState({
      routeInstructions: [
        { agentName: 'a', priority: 'high', instanceId: 'a#1' },
        { agentName: 'a', priority: 'low', instanceId: 'a#2' },
      ],
      subAgentResults: [
        {
          agentName: 'a',
          priority: 'high',
          instanceId: 'a#1',
          claims: [{ content: 'c-high', sourceAgent: 'a' }],
          rawResponse: '',
        },
        {
          agentName: 'a',
          priority: 'low',
          instanceId: 'a#2',
          claims: [{ content: 'c-low', sourceAgent: 'a' }],
          rawResponse: '',
        },
      ],
      mergedClaims: [
        { content: 'c-high', sourceAgent: 'a', shouldSave: true },
        { content: 'c-low', sourceAgent: 'a', shouldSave: true },
      ],
    })
    const doc = docCreate('n1')
    docUpdateInterrupt(doc, {
      runId: 'r1',
      mapId: 'n1',
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      transitionKey: '1-2',
      nextNode: 'validate',
      mode: 'human-in-loop',
      state,
      focus: { kind: 'news', id: MAP_DEFAULT_NEWS_ID },
      pendingTool: 'validate',
    })
    const edge = (from: string, to: string) =>
      doc.edges.some(e => e.from === from && e.to === to)
    expect(edge('sub:a#1', 'draft:0')).toBe(true)
    expect(edge('sub:a#2', 'draft:1')).toBe(true)
  })

  it('docReadRoutes 从图上 subAgent 读路由', () => {
    const doc = docCreate('n1')
    doc.nodes = [
      { id: MAP_DEFAULT_NEWS_ID, kind: 'news', params: { content: 'x' } },
      {
        id: 'sub:a#1',
        kind: 'subAgent',
        parentId: MAP_DEFAULT_NEWS_ID,
        params: { agentName: 'a', priority: 'high', instanceId: 'a#1' },
      },
    ]
    expect(docReadRoutes(doc, MAP_DEFAULT_NEWS_ID)).toEqual([
      { agentName: 'a', priority: 'high', instanceId: 'a#1' },
    ])
  })

  it('docAddRootNews 追加独立新闻根', () => {
    const doc = docCreate('n1')
    const newsId = docAddRootNews(doc)
    expect(doc.nodes.some(n => n.id === newsId && n.kind === 'news' && !n.parentId)).toBe(true)
  })

  it('docAddRootClaim 追加独立事实根', () => {
    const doc = docCreate('n1')
    const claimId = docAddRootClaim(doc)
    const claim = doc.nodes.find(n => n.id === claimId)
    expect(claim?.kind).toBe('claim')
    expect(claim?.parentId).toBeUndefined()
  })

  it('双 scoped news 拆分 draft claim id 不碰撞、parent 不错挂', () => {
    const newsA = mapIdCreateNews('aaaa1111')
    const newsB = mapIdCreateNews('bbbb2222')
    const doc = docCreate('n1')
    doc.nodes = [
      { id: newsA, kind: 'news', params: { content: '新闻A' } },
      { id: newsB, kind: 'news', params: { content: '新闻B' } },
    ]

    const runSplit = (newsId: string, agentName: string, content: string, runId: string) => {
      docUpdateInterrupt(doc, {
        runId,
        mapId: 'n1',
        parentNodeId: newsId,
        transitionKey: '1-2',
        nextNode: 'validate',
        mode: 'human-in-loop',
        state: splitState({
          parentNodeId: newsId,
          content: newsId === newsA ? '新闻A' : '新闻B',
          routeInstructions: [
            { agentName, priority: 'medium', instanceId: `${agentName}#1` },
          ],
          subAgentResults: [
            {
              agentName,
              priority: 'medium',
              instanceId: `${agentName}#1`,
              claims: [{ content, sourceAgent: agentName }],
              rawResponse: '',
            },
          ],
          mergedClaims: [{ content, sourceAgent: agentName, shouldSave: true }],
        }),
        focus: { kind: 'news', id: newsId },
        pendingTool: 'validate',
      })
    }

    runSplit(newsA, '医疗事实', '医疗 claim', 'r1')
    runSplit(newsB, '政治事实', '政治 claim', 'r2')

    const drafts = doc.nodes.filter(
      (n): n is MapClaimNode => n.kind === 'claim' && n.id.startsWith('draft:'),
    )
    expect(drafts).toHaveLength(2)
    expect(drafts.map(d => d.id).sort()).toEqual([
      mapIdCreateDraftClaim(0, newsA),
      mapIdCreateDraftClaim(0, newsB),
    ].sort())

    const medicalDraft = drafts.find(d => d.id === mapIdCreateDraftClaim(0, newsA))
    const politicalDraft = drafts.find(d => d.id === mapIdCreateDraftClaim(0, newsB))
    expect(medicalDraft?.parentId).toBe(`sub:${newsA}:医疗事实#1`)
    expect(politicalDraft?.parentId).toBe(`sub:${newsB}:政治事实#1`)
    expect(medicalDraft?.params.content).toBe('医疗 claim')
    expect(politicalDraft?.params.content).toBe('政治 claim')
  })
})

describe('graph-doc tools', () => {
  it('docDedupClaims 同 parent 下按 content+category 去重', () => {
    const parent = 'sub:news:1:agent#1'
    const doc: MapGraphDoc = {
      mapId: 'm1',
      nodes: [
        {
          id: 'c1',
          kind: 'claim',
          parentId: parent,
          params: { content: 'Hello', category: 'fact' },
        },
        {
          id: 'c2',
          kind: 'claim',
          parentId: parent,
          params: { content: 'hello', category: 'fact' },
        },
        {
          id: 'c3',
          kind: 'claim',
          parentId: parent,
          params: { content: 'Hello', category: 'opinion' },
        },
        {
          id: 'c4',
          kind: 'claim',
          parentId: 'sub:other',
          params: { content: 'Hello', category: 'fact' },
        },
      ],
      edges: [],
      runPhase: 'idle',
      mode: 'human-in-loop',
      timeline: timelineCreateDefault(),
    }
    const result = docDedupClaims(doc)
    expect(result.removedIds).toEqual(['c2'])
    expect(result.kept).toBe(3)
    expect(doc.nodes.map(n => n.id).sort()).toEqual(['c1', 'c3', 'c4'])
  })

  it('docBatchUpdateSubAgents 按 agentName 批量改 priority/hint', () => {
    const doc: MapGraphDoc = {
      mapId: 'm1',
      nodes: [
        {
          id: 'sa1',
          kind: 'subAgent',
          parentId: 'news:1',
          params: { agentName: 'a', priority: 'low', instanceId: 'a#1' },
        },
        {
          id: 'sa2',
          kind: 'subAgent',
          parentId: 'news:1',
          params: { agentName: 'b', priority: 'low', instanceId: 'b#1' },
        },
      ],
      edges: [],
      runPhase: 'idle',
      mode: 'human-in-loop',
      timeline: timelineCreateDefault(),
    }
    const count = docBatchUpdateSubAgents(doc, {
      agentName: 'a',
      priority: 'high',
      hint: 'focus',
    })
    expect(count).toBe(1)
    const sa1 = doc.nodes.find(n => n.id === 'sa1')
    expect(sa1?.kind).toBe('subAgent')
    if (sa1?.kind === 'subAgent') {
      expect(sa1.params.priority).toBe('high')
      expect(sa1.params.hint).toBe('focus')
    }
  })
})
