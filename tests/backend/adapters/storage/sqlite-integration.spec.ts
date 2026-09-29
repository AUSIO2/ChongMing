// 文件职责：通过真实 API、进程内消息和 DSH 验证 SQLite 全业务闭环。
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureCreateEnvironment, type UiFixture } from '../../../client/ui-fixture'
import { clientCreateGateway } from '../../../../client/graph-client'
import type { GraphSnapshot } from '../../../../contracts/graph'
import type { GraphStreamEvent } from '../../../../contracts/events'
import { FACT_TYPES, sourceFactCheckPlan, verificationPlan } from '../../fixtures/graph-api'

let fixture: UiFixture
let gateway: ReturnType<typeof clientCreateGateway>
beforeAll(async () => {
  // 启动 SQLite 端到端环境并使用用户令牌连接客户端网关。
  fixture = await fixtureCreateEnvironment({ storage: 'sqlite' })
  gateway = clientCreateGateway({ baseUrl: fixture.baseUrl })
  await gateway.connect({ baseUrl: fixture.baseUrl, token: fixture.token, remember: false })
}, 20_000)
afterAll(async () => {
  // 先断开客户端，再关闭服务与模型夹具。
   await gateway?.disconnect(); await fixture?.close() }, 20_000)
async function sqliteWaitMap(/* 需要等待业务状态变化的图身份。 */ mapId: string, /* 指定本用例完成边界的纯条件函数，例如 Run 完成或审核建立。 */ predicate: (/* 客户端刚读取的最新图快照，提供给等待条件判断。 */ snapshot: GraphSnapshot) => boolean) {
  // 有界等待图到达指定业务状态，失败 Run 立即报告原因。
  const deadline = Date.now() + 70_000
  while (Date.now() < deadline) {
    const snapshot = await gateway.read('map.get', { mapId })
    if (snapshot.runs.some(run => run.status === 'failed')) throw new Error(JSON.stringify(snapshot.runs.find(run => run.status === 'failed')?.error))
    if (predicate(snapshot)) return snapshot
    await delay(40)
  }
  throw new Error('Local flow did not reach its business boundary')
}
describe('SQLite / in-process notifications / real DSH', () => {
  // 覆盖本机解析核查、暂停审核与附件导入导出的跨层流程。
  it('parses sources, splits independent facts, verifies all successors and streams snapshots without an external broker', async () => {
    // 验证无需外部 broker 即可完成来源解析、事实拆分和全部后继核查并推送 SSE。
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const mapId = randomUUID(), sourceId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'SQLite full flow' })
    const events: GraphStreamEvent[] = [], stop = new AbortController()
    const streaming = gateway.watch(mapId, /* 客户端 SSE 网关推送的公共事件，记录以检查最终快照和活动通知。 */ event => /* 保存实时事件，供快照与活动推送断言。 */  events.push(event), stop.signal).catch(/* 订阅 Promise 的结束异常，只有测试主动取消时才忽略。 */ error => {
      // 正常取消订阅时吞掉中止错误，其余断流失败继续报告。
       if (!stop.signal.aborted) throw error })
    try {
      await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [sourceId], expectedVersion: null },
        changes: { nodes: { put: [{ id: sourceId, typeId: FACT_TYPES.source.id, typeVersion: 1,
          payload: { locator: { kind: 'url', url: fixture.sourceUrl }, label: 'SQLite source' } }] } } })
      const runBranch = await gateway.read('branch.get', { mapId, rootIds: [sourceId] })
      await gateway.dispatch(randomUUID(), 'run.start', { mapId, id: randomUUID(),
        branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version },
        scope: { nodeIds: [sourceId] }, plan: sourceFactCheckPlan([sourceId]), mode: 'auto' })
      const final = await sqliteWaitMap(mapId, /* 来源处理期间读取的图快照，等待当前 Run 完成。 */ snapshot => /* 等待本次来源处理 Run 完成。 */  snapshot.runs.some(run => run.status === 'completed'))
      expect(final.nodes.filter(node => node.typeId === FACT_TYPES.news.id)).toHaveLength(1)
      expect(final.nodes.filter(node => node.typeId === FACT_TYPES.claim.id)).toHaveLength(2)
      expect(final.nodes.filter(node => node.typeId === FACT_TYPES.verification.id)).toHaveLength(2)
      expect(final.runs[0].operations).toHaveLength(4)
      await expect.poll(() => /* 轮询事件缓存，确认已推送最终图版本。 */  events.some(/* 缓存 SSE 事件，检查快照版本是否等于最终持久化版本。 */ event => /* 识别与最终持久化版本相同的快照事件。 */  event.type === 'snapshot' && event.snapshot.revision === final.revision)).toBe(true)
      expect(events.some(/* 缓存 SSE 事件，查找含非空活动列表的执行摘要。 */ event => /* 确认执行期间收到过非空活动摘要。 */  event.type === 'activity' && event.items.length > 0)).toBe(true)
      expect(fixture.errors).toEqual([])
    } finally { stop.abort(); await streaming }
  }, 80_000)

  it('preserves Review decisions while paused and reuses saved opinions on continuation', async () => {
    // 验证暂停期间审核仍可保存，恢复后保留意见并完成结果审核。
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const mapId = randomUUID(), claimId = randomUUID(), runId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Local pause' })
    await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [claimId], expectedVersion: null },
      changes: { nodes: { put: [{ id: claimId, typeId: FACT_TYPES.claim.id, typeVersion: 1,
        payload: { content: 'SQLite pause resume fact', category: null } }] } } })
    const runBranch = await gateway.read('branch.get', { mapId, rootIds: [claimId] })
    const started = await gateway.dispatch(randomUUID(), 'run.start', { mapId, id: runId,
      branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version },
      scope: { nodeIds: [claimId] }, plan: verificationPlan([claimId]), mode: 'human-in-loop' })
    expect(started.data.runControl).toBeUndefined()
    const waiting = await sqliteWaitMap(mapId, snapshot => snapshot.runs.find(run => run.id === runId)?.operations[0].review?.kind === 'plan')
    const paused = await gateway.dispatch(randomUUID(), 'run.pause', { mapId, runId })
    const operation = paused.data.snapshot.runs.find(run => run.id === runId)!.operations[0]
    const approved = await gateway.dispatch(randomUUID(), 'review.answer', { mapId, runId, operationId: operation.id,
      reviewId: operation.review!.id, expectedReviewRevision: operation.review!.revision, decision: 'approve' })
    expect(approved.data.snapshot.runs.find(run => run.id === runId)?.paused).toBe(true)
    await gateway.dispatch(randomUUID(), 'run.resume', { mapId, runId })
    const result = await sqliteWaitMap(mapId, /* 当前图快照，判断是否已经建立汇总结果审核。 */ snapshot => /* 等待结果审核建立，确认工作意见已全部提交。 */  snapshot.runs.find(run => run.id === runId)?.operations[0].review?.kind === 'result')
    const resultRun = result.runs.find(run => run.id === runId)!
    expect(resultRun.operations[0].stages.find(stage => stage.stageId === 'assess')?.results).toHaveLength(3)
    const final = await gateway.dispatch(randomUUID(), 'review.answer', { mapId, runId, operationId: operation.id,
      reviewId: resultRun.operations[0].review!.id, expectedReviewRevision: resultRun.operations[0].review!.revision, decision: 'approve' })
    expect(final.data.snapshot.runs.find(run => run.id === runId)?.status).toBe('completed')
  }, 70_000)

  it('roundtrips assets and imports an exported workspace with remapped references', async () => {
    // 验证附件下载字节一致，导出导入后引用重映射且不携带可运行 Run。
    const workspace = await gateway.read('workspace.get', { workspaceId: fixture.workspaceId })
    const bytes = new TextEncoder().encode('SQLite shared source file')
    const file = await gateway.upload(randomUUID(), { workspaceId: workspace.id, filename: 'source.txt', mediaType: 'text/plain', bytes })
    const mapId = randomUUID()
    const created = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Asset map' })
    const sourceId = randomUUID()
    await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [sourceId], expectedVersion: null }, changes: { nodes: { put: [{
      id: sourceId, typeId: FACT_TYPES.source.id, typeVersion: 1,
      payload: { locator: { kind: 'asset', assetId: file.data.id, mediaType: file.data.mediaType }, label: null },
    }] } } })
    expect((await gateway.download({ kind: 'asset', id: file.data.id })).bytes).toEqual(bytes)
    const exported = await gateway.download({ kind: 'map', id: mapId })
    const staged = await gateway.upload(randomUUID(), { workspaceId: workspace.id, filename: 'map.json', mediaType: 'application/json', bytes: exported.bytes })
    const imported = await gateway.dispatch(randomUUID(), 'workspace.import', { id: randomUUID(), bundleAssetId: staged.data.id, stagingWorkspaceId: workspace.id, name: 'Imported SQLite' })
    const copy = await gateway.read('map.get', { mapId: imported.data.mapIds[0] })
    expect(copy.workspaceId).toBe(imported.data.workspaceId)
    expect(copy.runs).toEqual([])
    expect(imported.data.assetIds).toHaveLength(1)
    expect((await gateway.download({ kind: 'asset', id: imported.data.assetIds[0] })).bytes).toEqual(bytes)
  })
})
