import { describe, expect, it } from 'vitest'
import { NEWS_ROOT_ID } from './ids'
import type { MapSnapshot } from './types'
import {
  canAddSubAgent,
  canEditNode,
  canRemoveNode,
  isParamsLocked,
} from './graph-ops'

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

describe('graph-ops', () => {
  it('允许在 idle 状态下往 news root 添加拆分 subAgent（快照里可能已有 news 节点）', () => {
    const snap = baseSnapshot({
      nodes: [
        {
          id: NEWS_ROOT_ID,
          kind: 'news',
          params: { content: '' },
        },
      ],
    })
    expect(canAddSubAgent(snap, NEWS_ROOT_ID)).toBe(true)
  })

  it('running 或 save 中断时禁止往新闻根添加；invoke 配置期允许（Route 后人工加槽）', () => {
    expect(canAddSubAgent(baseSnapshot({ runPhase: 'running' }), NEWS_ROOT_ID)).toBe(false)
    expect(canAddSubAgent(
      baseSnapshot({ runPhase: 'interrupted', pendingTool: 'save' }),
      NEWS_ROOT_ID,
    )).toBe(false)
    expect(canAddSubAgent(
      baseSnapshot({ runPhase: 'interrupted', pendingTool: 'invoke' }),
      NEWS_ROOT_ID,
    )).toBe(true)
  })

  it('允许把核查 subAgent 挂到已持久化的 claim 上', () => {
    const claim: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'persisted',
    }
    const snap = baseSnapshot({ nodes: [claim] })
    expect(canAddSubAgent(snap, 'claim:x:0')).toBe(true)
  })

  it('HITL interrupted 时仍允许往已持久化 claim 添加核查 subAgent', () => {
    const claim: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'persisted',
    }
    const snap = baseSnapshot({
      runPhase: 'interrupted',
      activeNodeId: 'claim:x:1',
      pendingTool: 'save',
      nodes: [claim],
    })
    expect(canAddSubAgent(snap, 'claim:x:0')).toBe(true)
  })

  it('running 时禁止往已持久化 claim 添加核查 subAgent', () => {
    const claim: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'persisted',
    }
    const snap = baseSnapshot({ runPhase: 'running', nodes: [claim] })
    expect(canAddSubAgent(snap, 'claim:x:0')).toBe(false)
  })

  it('禁止把核查 subAgent 挂到未持久化的 claim 上', () => {
    const claim: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'pendingValidated',
    }
    const snap = baseSnapshot({ nodes: [claim] })
    expect(canAddSubAgent(snap, 'claim:x:0')).toBe(false)
  })

  it('claim 一旦离开 workerOut 就锁定参数', () => {
    const workerOut: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'workerOut',
    }
    const persisted = { ...workerOut, dataPhase: 'persisted' as const }
    const snap = baseSnapshot({ nodes: [workerOut, persisted] })
    expect(isParamsLocked(snap, workerOut)).toBe(false)
    expect(isParamsLocked(snap, persisted)).toBe(true)
  })

  it('subAgent 只要下游有产出就锁定，即使产出仍处于 workerOut', () => {
    const sa: MapSnapshot['nodes'][number] = {
      id: 'sub:x',
      kind: 'subAgent',
      params: { agentName: 'a', displayLabel: 'A', priority: 'medium' },
    }
    const child: MapSnapshot['nodes'][number] = {
      id: 'claim:x:0',
      kind: 'claim',
      parentId: 'sub:x',
      params: { content: 'c' },
      dataPhase: 'workerOut',
    }
    const snap = baseSnapshot({ nodes: [sa, child] })
    expect(isParamsLocked(snap, sa)).toBe(true)
    expect(canEditNode(snap, sa.id)).toBe(false)
    expect(canEditNode(snap, child.id)).toBe(true)
  })

  it('仅允许删除无下游的 subAgent 槽；save 中断期禁止', () => {
    const sa: MapSnapshot['nodes'][number] = {
      id: 'sub:x',
      kind: 'subAgent',
      parentId: NEWS_ROOT_ID,
      params: { agentName: 'a', displayLabel: 'A', priority: 'medium' },
    }
    expect(canRemoveNode(baseSnapshot({ nodes: [sa] }), sa.id)).toBe(true)
    expect(canRemoveNode(
      baseSnapshot({
        runPhase: 'interrupted',
        pendingTool: 'invoke',
        nodes: [sa],
      }),
      sa.id,
    )).toBe(true)
    expect(canRemoveNode(
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
    }
    expect(canRemoveNode(baseSnapshot({ nodes: [sa, child] }), sa.id)).toBe(false)
  })
})
