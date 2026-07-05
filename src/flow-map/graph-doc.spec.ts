import { describe, expect, it } from 'vitest'
import { NEWS_ROOT_ID } from './ids'
import type { MapSnapshot } from './types'
import {
  docUpdateInterrupt,
  docUpdateProgress,
  docCreateNews,
  docReadResume,
  docCanAddSubAgent,
  docCanEditNode,
  docCanRemoveNode,
  docCreate,
  docUpdateSubAgent,
  docIsParamLock,
  docDeleteClaims,
  docResetNews,
  docUpdateDraft,
  docReadRoutes,
  type MapGraphDoc,
} from './graph-doc'
import type { DisplayNews, GraphInterruptedPayload, GraphSplitState } from '../../electron/api/types'

function baseSnapshot(overrides: Partial<MapSnapshot> = {}): MapSnapshot {
  return {
    newsId: 'n1',
    nodes: [],
    edges: [],
    runPhase: 'idle',
    mode: 'human-in-loop',
    ...overrides,
  }
}

describe('graph-doc capability', () => {
  it('idle 只编辑正文，禁止预置拆分 subAgent', () => {
    const snap = baseSnapshot({
      nodes: [
        {
          id: NEWS_ROOT_ID,
          kind: 'news',
          params: { content: '' },
        },
      ],
    })
    expect(docCanAddSubAgent(snap, NEWS_ROOT_ID)).toBe(false)
    expect(docIsParamLock(snap, snap.nodes[0])).toBe(false)
  })

  it('非 idle 时锁定新闻正文', () => {
    const news = {
      id: NEWS_ROOT_ID,
      kind: 'news' as const,
      params: { content: 'x' },
    }
    expect(docIsParamLock(baseSnapshot({ runPhase: 'running', nodes: [news] }), news)).toBe(true)
    expect(docIsParamLock(
      baseSnapshot({ runPhase: 'interrupted', pendingTool: 'invoke', nodes: [news] }),
      news,
    )).toBe(true)
  })

  it('running 或 save 中断时禁止添加；confirmRoute(invoke) 允许', () => {
    expect(docCanAddSubAgent(baseSnapshot({ runPhase: 'running' }), NEWS_ROOT_ID)).toBe(false)
    expect(docCanAddSubAgent(
      baseSnapshot({ runPhase: 'interrupted', pendingTool: 'save' }),
      NEWS_ROOT_ID,
    )).toBe(false)
    expect(docCanAddSubAgent(
      baseSnapshot({ runPhase: 'interrupted', pendingTool: 'invoke' }),
      NEWS_ROOT_ID,
    )).toBe(true)
  })

  it('仅 invoke 配置期允许往已持久化 claim 添加核查 subAgent', () => {
    const claim: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'persisted',
      shouldSave: true,
    }
    expect(docCanAddSubAgent(baseSnapshot({ nodes: [claim] }), 'claim:x:0')).toBe(false)
    expect(docCanAddSubAgent(
      baseSnapshot({
        runPhase: 'interrupted',
        pendingTool: 'invoke',
        nodes: [claim],
      }),
      'claim:x:0',
    )).toBe(true)
    expect(docCanAddSubAgent(
      baseSnapshot({
        runPhase: 'interrupted',
        pendingTool: 'save',
        nodes: [claim],
      }),
      'claim:x:0',
    )).toBe(false)
  })

  it('running 时禁止往已持久化 claim 添加核查 subAgent', () => {
    const claim: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'persisted',
      shouldSave: true,
    }
    const snap = baseSnapshot({ runPhase: 'running', nodes: [claim] })
    expect(docCanAddSubAgent(snap, 'claim:x:0')).toBe(false)
  })

  it('禁止把核查 subAgent 挂到未持久化的 claim 上', () => {
    const claim: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'workerOut',
      shouldSave: true,
    }
    const snap = baseSnapshot({
      runPhase: 'interrupted',
      pendingTool: 'invoke',
      nodes: [claim],
    })
    expect(docCanAddSubAgent(snap, 'claim:x:0')).toBe(false)
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

  it('仅 invoke 配置期允许删除无下游的 subAgent 槽', () => {
    const sa: MapSnapshot['nodes'][number] = {
      id: 'sub:x',
      kind: 'subAgent',
      parentId: NEWS_ROOT_ID,
      params: { agentName: 'a', priority: 'medium', instanceId: 'a' },
    }
    expect(docCanRemoveNode(baseSnapshot({ nodes: [sa] }), sa.id)).toBe(false)
    expect(docCanRemoveNode(
      baseSnapshot({
        runPhase: 'interrupted',
        pendingTool: 'invoke',
        nodes: [sa],
      }),
      sa.id,
    )).toBe(true)
    expect(docCanRemoveNode(
      baseSnapshot({
        runPhase: 'interrupted',
        pendingTool: 'save',
        nodes: [sa],
      }),
      sa.id,
    )).toBe(false)

    const child: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: sa.id,
      params: { content: 'c' },
      dataPhase: 'workerOut',
      shouldSave: true,
    }
    expect(docCanRemoveNode(
      baseSnapshot({
        runPhase: 'interrupted',
        pendingTool: 'invoke',
        nodes: [sa, child],
      }),
      sa.id,
    )).toBe(false)
  })
})

function emptyNews(id = 'n1'): DisplayNews {
  return {
    _id: id,
    content: 'hello',
    context: {},
    claims: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function splitState(overrides: Partial<GraphSplitState> = {}): GraphSplitState {
  return {
    newsId: 'n1',
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
  it('docResetNews 清空 runId / draft / graphType / focus', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    doc.graphType = 'split'
    doc.draft = splitState()
    doc.activeNodeId = NEWS_ROOT_ID
    doc.pendingTool = 'validate'
    doc.error = 'x'
    docResetNews(doc, emptyNews())
    expect(doc.runPhase).toBe('idle')
    expect(doc.runId).toBeUndefined()
    expect(doc.graphType).toBeUndefined()
    expect(doc.draft).toBeUndefined()
    expect(doc.activeNodeId).toBeUndefined()
    expect(doc.pendingTool).toBeUndefined()
    expect(doc.error).toBeUndefined()
    expect(doc.nodes.some(n => n.kind === 'news')).toBe(true)
  })

  it('docUpdateProgress 在焦点上挂 activeTool，并清 snapshot pendingTool', () => {
    const doc = docCreate('n1')
    doc.nodes = [{ id: NEWS_ROOT_ID, kind: 'news', params: { content: 'x' } }]
    doc.runPhase = 'interrupted'
    doc.runId = 'run-1'
    doc.activeNodeId = NEWS_ROOT_ID
    doc.pendingTool = 'validate'
    doc.nodes[0].runtime = { pendingTool: 'validate' }

    docUpdateProgress(doc, {
      runId: 'run-1',
      newsId: 'n1',
      graphType: 'split',
      event: 'node_enter',
      node: '',
    })
    expect(doc.runPhase).toBe('running')
    expect(doc.pendingTool).toBeUndefined()
    expect(doc.activeNodeId).toBe(NEWS_ROOT_ID)
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
      graphType: 'split',
      nextNode: 'validate',
      mode: 'human-in-loop',
      state,
      focus: { kind: 'news', id: NEWS_ROOT_ID },
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

  it('verify 同名多槽：各挂一条 opinion，不合并到同一 subAgent', () => {
    const claimId = '2'
    const doc = docCreate('n1')
    doc.nodes = [
      { id: NEWS_ROOT_ID, kind: 'news', params: { content: 'x' } },
      {
        id: claimId,
        kind: 'claim',
        parentId: NEWS_ROOT_ID,
        params: { content: 'c' },
        dataPhase: 'persisted',
        shouldSave: true,
      },
    ]
    const payload: GraphInterruptedPayload = {
      runId: 'r1',
      graphType: 'verify',
      nextNode: 'save',
      mode: 'human-in-loop',
      focus: { kind: 'opinion', id: 'opinion:2:0' },
      pendingTool: 'save',
      state: {
        newsId: 'n1',
        claimId,
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

  it('docUpdateSubAgent 重复 id 更新 parent、边不重复', () => {
    const doc: MapGraphDoc = docCreate('n1')
    doc.nodes = [{ id: NEWS_ROOT_ID, kind: 'news', params: { content: '' } }]
    const id1 = docUpdateSubAgent(doc, NEWS_ROOT_ID, {
      agentName: 'a',
      priority: 'medium',
      instanceId: 'a',
    })
    const id2 = docUpdateSubAgent(doc, NEWS_ROOT_ID, {
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

  it('docCreateNews 从 opinion / route 还原 SubAgent 槽', () => {
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
    } as DisplayNews

    const doc = docCreateNews(news)
    const sub = doc.nodes.find(n => n.kind === 'subAgent' && n.parentId === '1')
    expect(sub?.id).toBe('sub:来源可信度#1')
    expect(doc.nodes.some(n => n.kind === 'opinion')).toBe(true)
  })

  it('subagent_tool start 写入 activeSkill（含 argsSummary）', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    docUpdateSubAgent(doc, NEWS_ROOT_ID, {
      agentName: '来源可信度',
      priority: 'high',
      instanceId: '来源可信度#1',
    })

    docUpdateProgress(doc, {
      runId: 'run-1',
      newsId: 'n1',
      graphType: 'split',
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
    docUpdateSubAgent(doc, NEWS_ROOT_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })
    docUpdateSubAgent(doc, NEWS_ROOT_ID, {
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
      newsId: 'n1',
      graphType: 'split',
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
    docUpdateSubAgent(doc, NEWS_ROOT_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })
    docUpdateSubAgent(doc, NEWS_ROOT_ID, {
      agentName: 'b',
      priority: 'medium',
      instanceId: 'b#1',
    })
    const subB = doc.nodes.find(n => n.id === 'sub:b#1')!
    subB.runtime = { activeSkill: { name: 'web_search', argsSummary: 'q2' } }

    docUpdateProgress(doc, {
      runId: 'run-1',
      newsId: 'n1',
      graphType: 'split',
      event: 'node_enter',
      node: 'subAgent',
    })

    expect(subB.runtime?.activeSkill).toEqual({ name: 'web_search', argsSummary: 'q2' })
  })

  it('node_exit subAgent 清除全部 activeSkill', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    docUpdateSubAgent(doc, NEWS_ROOT_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })
    const subA = doc.nodes.find(n => n.id === 'sub:a#1')!
    subA.runtime = { activeSkill: { name: 'web_search' } }

    docUpdateProgress(doc, {
      runId: 'run-1',
      newsId: 'n1',
      graphType: 'split',
      event: 'node_exit',
      node: 'subAgent',
    })

    expect(subA.runtime).toBeUndefined()
  })

  it('verify：subagent_tool 按 nodeId 匹配节点', () => {
    const doc = docCreate('n1')
    doc.runId = 'run-1'
    doc.runPhase = 'running'
    doc.graphType = 'verify'
    doc.draft = {
      newsId: 'n1',
      claimId: '1',
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
      newsId: 'n1',
      graphType: 'verify',
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

  it('fanout_spawn 在 auto 模式下创建 SubAgent 节点，subagent_tool 可写入 activeSkill', () => {
    const doc = docCreate('n1')
    doc.runPhase = 'running'
    doc.graphType = 'split'
    doc.runId = 'run-1'

    docUpdateProgress(doc, {
      runId: 'run-1',
      newsId: 'n1',
      graphType: 'split',
      event: 'fanout_spawn',
      node: 'subAgent',
      agentName: '来源可信度',
      nodeId: 'sub:来源可信度#1',
      parentNodeId: NEWS_ROOT_ID,
      spawnIndex: 0,
    })

    expect(doc.nodes.some(n => n.id === 'sub:来源可信度#1')).toBe(true)

    docUpdateProgress(doc, {
      runId: 'run-1',
      newsId: 'n1',
      graphType: 'split',
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
    docUpdateSubAgent(doc, NEWS_ROOT_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })

    docUpdateProgress(doc, {
      runId: 'run-b',
      newsId: 'n1',
      graphType: 'split',
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
    docUpdateSubAgent(doc, NEWS_ROOT_ID, {
      agentName: 'a',
      priority: 'high',
      instanceId: 'a#1',
    })

    docUpdateProgress(doc, {
      runId: 'run-1',
      newsId: 'n1',
      graphType: 'split',
      event: 'node_enter',
      node: 'subAgent',
    })

    expect(doc.runPhase).toBe('completed')
  })

  it('docUpdateInterrupt 同 gate 幂等', () => {
    const doc = docCreate('n1')
    const payload: GraphInterruptedPayload = {
      runId: 'r1',
      graphType: 'split',
      nextNode: 'validate',
      mode: 'human-in-loop',
      state: splitState(),
      focus: { kind: 'news', id: NEWS_ROOT_ID },
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
    docUpdateInterrupt(doc, {
      runId: 'r1',
      graphType: 'split',
      nextNode: 'save',
      mode: 'human-in-loop',
      state,
      focus: { kind: 'news', id: NEWS_ROOT_ID },
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
      graphType: 'split',
      nextNode: 'confirmRoute',
      mode: 'human-in-loop',
      state,
      focus: { kind: 'news', id: NEWS_ROOT_ID },
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
      graphType: 'split',
      nextNode: 'validate',
      mode: 'human-in-loop',
      state,
      focus: { kind: 'news', id: NEWS_ROOT_ID },
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
      { id: NEWS_ROOT_ID, kind: 'news', params: { content: 'x' } },
      {
        id: 'sub:a#1',
        kind: 'subAgent',
        parentId: NEWS_ROOT_ID,
        params: { agentName: 'a', priority: 'high', instanceId: 'a#1' },
      },
    ]
    expect(docReadRoutes(doc, NEWS_ROOT_ID)).toEqual([
      { agentName: 'a', priority: 'high', instanceId: 'a#1' },
    ])
  })
})
