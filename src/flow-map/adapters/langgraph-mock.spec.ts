import { beforeEach, describe, expect, it } from 'vitest'
import { NEWS_ROOT_ID } from '../ids'
import { canAddSubAgent } from '../graph-ops'
import {
  __resetMockIdCounter,
  createLangGraphMockAdapter,
} from './langgraph-mock'
import type { MapAPI } from '../api'
import type { MapSnapshot } from '../types'

const NEWS_ID = 'news-1'

async function bootstrap(): Promise<{ api: MapAPI; snap: () => Promise<MapSnapshot> }> {
  const api = createLangGraphMockAdapter({
    seedNews: [{ newsId: NEWS_ID, title: 't', content: '正文内容示例' }],
  })
  const snap = () => api.getSnapshot(NEWS_ID)
  return { api, snap }
}

function addSplitSubAgent(api: MapAPI, name: string) {
  return api.addSubAgent({
    newsId: NEWS_ID,
    parentNodeId: NEWS_ROOT_ID,
    params: { agentName: name, displayLabel: name, priority: 'medium' },
  })
}

describe('langgraph-mock adapter', () => {
  beforeEach(() => __resetMockIdCounter())

  it('初始快照为 idle，只有新闻节点', async () => {
    const { snap } = await bootstrap()
    const s = await snap()
    expect(s.runPhase).toBe('idle')
    expect(s.nodes).toHaveLength(1)
    const news = s.nodes[0]
    expect(news.kind).toBe('news')
    expect(news.id).toBe(NEWS_ROOT_ID)
    expect(news.parentId).toBeUndefined()
  })

  it('startRun：Route Agent 预置拆分槽后进入 invoke 中断，此时尚无 claim，人工仍可加槽', async () => {
    const { api, snap } = await bootstrap()
    await api.startRun(NEWS_ID)
    const s = await snap()
    const underNews = s.nodes.filter(n => n.kind === 'subAgent' && n.parentId === NEWS_ROOT_ID)
    expect(underNews.length).toBeGreaterThan(0)
    expect(s.nodes.some(n => n.kind === 'claim')).toBe(false)
    expect(s.runPhase).toBe('interrupted')
    expect(s.pendingTool).toBe('invoke')
    expect(s.activeNodeId).toBe(NEWS_ROOT_ID)
    expect(canAddSubAgent(s, NEWS_ROOT_ID)).toBe(true)
    // Route 槽带真实 priority / hint
    for (const n of underNews) {
      expect(n.kind).toBe('subAgent')
      if (n.kind !== 'subAgent') continue
      expect(['high', 'medium', 'low']).toContain(n.params.priority)
      expect(n.params.hint).toBeTruthy()
    }

    await api.addSubAgent({
      newsId: NEWS_ID,
      parentNodeId: NEWS_ROOT_ID,
      params: { agentName: 'extra-agent', displayLabel: '人工加槽', priority: 'low', hint: '人工补充视角' },
    })
    const after = await snap()
    expect(
      after.nodes.some(n => n.kind === 'subAgent' && n.params.agentName === 'extra-agent'),
    ).toBe(true)
  })

  it('addSubAgent(NEWS_ROOT_ID) 生成拆分节点，父 id 指向新闻节点，并有一条边', async () => {
    const { api, snap } = await bootstrap()
    await addSplitSubAgent(api, 'fact-splitter')
    const s = await snap()
    expect(s.nodes.some(n => n.kind === 'news')).toBe(true)
    const sub = s.nodes.find(n => n.kind === 'subAgent')!
    expect(sub.parentId).toBe(NEWS_ROOT_ID)
    expect(s.edges.some(e => e.from === NEWS_ROOT_ID && e.to === sub.id)).toBe(true)
  })

  it('invoke 确认后每个拆分 subAgent 产出 claim；焦点在首个 workerOut claim 上，pendingTool=save', async () => {
    const { api, snap } = await bootstrap()
    await addSplitSubAgent(api, 'fact-splitter')
    await addSplitSubAgent(api, 'quote-extractor')

    await api.startRun(NEWS_ID)
    await api.continueStep(NEWS_ID) // 确认 invoke
    const s = await snap()

    expect(s.runPhase).toBe('interrupted')
    expect(s.pendingTool).toBe('save')
    expect(s.activeNodeId).toBeTruthy()

    const focusNodes = s.nodes.filter(n => n.id === s.activeNodeId)
    expect(focusNodes).toHaveLength(1)
    expect(focusNodes[0].runtime?.pendingTool).toBe('save')
    expect(s.nodes.filter(n => n.runtime?.pendingTool).length).toBe(1)

    const claims = s.nodes.filter(n => n.kind === 'claim')
    expect(claims.length).toBeGreaterThanOrEqual(4)
    for (const c of claims) {
      expect(c.parentId?.startsWith('sub:')).toBe(true)
    }

    expect(s.nodes.some(n => n.kind === 'news' && n.id === NEWS_ROOT_ID)).toBe(true)
  })

  it('claim save 后跑 Verify Route Agent 预置核查槽；核查 invoke 前人工仍可加槽', async () => {
    const { api, snap } = await bootstrap()
    await addSplitSubAgent(api, 'fact-splitter')
    await api.startRun(NEWS_ID)
    await api.continueStep(NEWS_ID) // split invoke

    const before = await snap()
    const active = before.activeNodeId!
    await api.continueStep(NEWS_ID) // save first claim → Verify Route
    const after = await snap()

    const commited = after.nodes.find(n => n.id === active)!
    expect(commited.kind).toBe('claim')
    if (commited.kind === 'claim') expect(commited.dataPhase).toBe('persisted')

    const verifySAs = after.nodes.filter(
      n => n.kind === 'subAgent' && n.parentId === active,
    )
    expect(verifySAs.length).toBeGreaterThan(0)

    // 若已进入该 claim 的 verify invoke 配置期，可再加槽
    let s = after
    let guard = 0
    while (s.runPhase === 'interrupted' && s.pendingTool === 'save') {
      s = await api.continueStep(NEWS_ID)
      guard += 1
      if (guard > 100) throw new Error('loop guard')
    }
    expect(s.pendingTool).toBe('invoke')
    expect(s.activeNodeId?.startsWith('claim:')).toBe(true)
    const claimFocus = s.activeNodeId!
    expect(canAddSubAgent(s, claimFocus)).toBe(true)
    await api.addSubAgent({
      newsId: NEWS_ID,
      parentNodeId: claimFocus,
      params: { agentName: 'extra-verify', displayLabel: '人工核查槽', priority: 'low' },
    })
    const withExtra = await snap()
    expect(
      withExtra.nodes.some(
        n => n.kind === 'subAgent' && n.parentId === claimFocus && n.params.agentName === 'extra-verify',
      ),
    ).toBe(true)

    s = await api.continueStep(NEWS_ID) // verify invoke
    expect(s.pendingTool).toBe('save')
    expect(s.activeNodeId?.startsWith('opinion:')).toBe(true)
  })

  it('全部 continueStep 后 runPhase=completed', async () => {
    const { api, snap } = await bootstrap()
    await addSplitSubAgent(api, 'fact-splitter')
    await api.startRun(NEWS_ID)

    let s = await snap()
    let guard = 0
    while (s.runPhase === 'interrupted') {
      s = await api.continueStep(NEWS_ID)
      guard += 1
      if (guard > 200) throw new Error('loop guard')
    }
    expect(s.runPhase).toBe('completed')
    expect(s.activeNodeId).toBeUndefined()
    expect(s.pendingTool).toBeUndefined()
  })

  it('MapSnapshot 上不出现 scope / stage / verifyByClaimId 等泄漏字段', async () => {
    const { api, snap } = await bootstrap()
    await addSplitSubAgent(api, 'fact-splitter')
    await api.startRun(NEWS_ID)
    await api.continueStep(NEWS_ID) // invoke
    await api.continueStep(NEWS_ID) // first save
    const s = await snap()
    const json = JSON.stringify(s)
    for (const forbidden of [
      '"scope"',
      '"stage"',
      '"verifyByClaimId"',
      '"routeInstructions"',
      '"subAgentResults"',
      '"pendingValidatedClaims"',
      '"isBridge"',
    ]) {
      expect(json).not.toContain(forbidden)
    }
  })

  it('onUpdated 会在 mutation 后触发', async () => {
    const { api } = await bootstrap()
    let calls = 0
    const off = api.onUpdated((id: string) => {
      if (id === NEWS_ID) calls += 1
    })
    await addSplitSubAgent(api, 'fact-splitter')
    await api.startRun(NEWS_ID)
    off()
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
