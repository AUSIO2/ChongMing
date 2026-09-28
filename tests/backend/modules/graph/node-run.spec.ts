// 验证节点范围驱动的解析、拆分和核查，以及审核并行、历史复用和暂停恢复竞争。
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'
import type { GraphChanges, GraphEdgeInput, GraphNodeData, GraphOperation, GraphRun, GraphSnapshot, GraphWorkGrant } from '../../../../contracts/graph'
import { createGraphApi, expectRejected, proof, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => {
  // 启动包含解析、拆分和核查配置的真实图服务，供多节点运行测试。
  api = await createGraphApi(60_000, DEFAULT_RUN_CONFIGURATION) }, 30_000)
afterAll(async () => {
  // 关闭多节点测试夹具及其数据库和队列。
  await api?.close() })

const news = (/* 测试新闻节点的正文。 */ content: string) => /* 生成带空上下文的独立新闻输入节点。 */ ({ id: randomUUID(), data: { kind: 'news' as const, content, context: {} } })
const claim = (/* 测试事实节点的正文。 */ content: string) => /* 生成带空类别的独立事实输入节点。 */ ({ id: randomUUID(), data: { kind: 'claim' as const, content, category: null } })

async function createMap(/* 创建图时一次写入的节点输入集合。 */ nodes: NonNullable<GraphChanges['nodes']>['put'], /* 创建图时一次写入的关系集合；默认没有关系。 */ edges: GraphEdgeInput[] = [], /* 可选复用的工作区身份和当前版本。 */ workspace?: { id: string; revision: number }) {
  // 创建指定节点和关系的图，可复用传入工作区以测试资产来源。
  const owner = workspace ?? await api.createWorkspace(DEFAULT_RUN_CONFIGURATION)
  const mapId = randomUUID()
  expect(await api.command('map.create', { workspaceId: owner.id, expectedRevision: owner.revision, id: mapId, name: 'Node closure' }))
    .toMatchObject({ status: 201 })
  expect(await api.command('graph.apply', { mapId, expectedRevision: 0, changes: { nodes: { put: nodes }, edges: { put: edges } } }))
    .toMatchObject({ status: 200 })
  return { mapId, workspaceId: owner.id }
}

async function start(/* 需要启动新 Run 的图身份。 */ mapId: string, /* 新 Run 显式选择的起点节点身份。 */ nodeIds: string[], /* 运行应处理到的最终阶段；默认完成核查。 */ until: GraphRun['until'] = 'verified', /* 自动执行或人工审核模式；默认自动。 */ mode: GraphRun['mode'] = 'auto'): Promise<GraphSnapshot> {
  // 读取当前图版本后启动指定范围、终止阶段和审核模式的 Run。
  const current = await api.snapshot(mapId)
  const result = await api.command('run.start', { mapId, expectedRevision: current.revision, id: randomUUID(), scope: { nodeIds }, until, mode })
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data.snapshot
}

function operation(/* 包含待查 Operation 的图快照。 */ snapshot: GraphSnapshot, /* Operation 必须处理的目标节点身份。 */ targetId: string): GraphOperation {
  // 按目标节点取得本 Run 的 Operation，并明确断言它已建立。
  const found = snapshot.run!.operations.find(/* 当前与目标节点身份比较的 Operation。 */ item => /* 在操作集合中定位处理该目标节点的操作。 */ item.targetId === targetId)
  expect(found, `operation for ${targetId}`).toBeDefined()
  return found!
}

async function take(/* 需要领取下一项工作的图身份。 */ mapId: string, /* 预期领取到的解析、路由、Worker 或汇总角色。 */ role: GraphWorkGrant['actor']['role'], /* 可选预期 Operation 身份，用于多节点运行区分工作。 */ operationId?: string) {
  // 领取下一项工作并核对角色及可选操作身份，确保后续提案提交到预期阶段。
  const grant = await api.claim(mapId, randomUUID())
  expect(grant).toMatchObject({ actor: { role }, ...(operationId ? { operationId } : {}) })
  return grant!
}

function proposal(/* 决定提案身份、路由版本和槽位的工作授权。 */ grant: GraphWorkGrant, /* 用例提供的提案种类和业务字段。 */ input: Record<string, unknown>) {
  // 根据授权拼装稳定提案身份及路由、槽位信息，供用例指定业务内容。
  return { mapId: grant.mapId, operationId: grant.operationId, id: grant.workId,
    ...(grant.routeRevision ? { routeRevision: grant.routeRevision } : {}),
    ...(grant.actor.role === 'worker' ? { slotId: grant.actor.slotId } : {}), ...input }
}

async function accept(/* 提交提案时使用的有效工作授权。 */ grant: GraphWorkGrant, /* 准备由服务端接纳的提案业务字段。 */ input: Record<string, unknown>): Promise<GraphSnapshot> {
  // 提交提案并断言接纳成功，返回提交后的图快照。
  const result = await api.propose(grant, proposal(grant, input))
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data
}

async function route(/* 必须属于路由角色的工作授权。 */ grant: GraphWorkGrant, /* 要从冻结配置选择的路由槽位数；默认一个。 */ count = 1) {
  // 按当前操作所属阶段选择可用 Agent，建立指定数量槽位并提交路由。
  const data = await api.read(grant)
  const agents = data.operationKind === 'split' ? data.configuration.split.agents : data.configuration.agents
  return accept(grant, { kind: 'route', reason: 'Independent node work',
    slots: agents.slice(0, count).map((/* 当前转换为测试路由槽位的冻结 Agent。 */ agent: { id: string; tools: string[] }, /* 当前 Agent 在所选配置切片中的零基序号。 */ index: number) => /* 为选中的 Agent 生成独立槽位身份和角度，并保留其允许工具。 */ ({
      id: `angle-${index}`, agentId: agent.id, angle: `angle-${index}`, priority: 'medium', hint: '', tools: agent.tools,
    })) })
}

async function answer(/* 包含待审 Operation 的图身份。 */ mapId: string, /* 需要批准当前待审记录的 Operation 身份。 */ operationId: string): Promise<GraphSnapshot> {
  // 读取指定操作的待审版本并提交批准，返回更新后的快照。
  const current: GraphSnapshot = await api.snapshot(mapId)
  const review = current.run!.operations.find(/* 当前与目标 Operation 身份比较的操作。 */ item => /* 定位需要批准的操作审核，避免误消费其他节点的审核。 */ item.id === operationId)!.review!
  expect(review.state).toBe('pending')
  const result = await api.command('review.answer', { mapId, expectedRevision: current.revision, runId: current.run!.id,
    operationId, reviewId: review.id, expectedReviewRevision: review.revision, decision: 'approve' })
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data.snapshot
}

async function control(/* 需要暂停或恢复当前 Run 的图身份。 */ mapId: string, /* 选择暂停还是恢复命令。 */ method: 'run.pause' | 'run.resume') {
  // 按最新图版本暂停或恢复当前 Run，并断言命令成功。
  const current = await api.snapshot(mapId)
  const result = await api.command(method, { mapId, expectedRevision: current.revision, runId: current.run.id })
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data.snapshot as GraphSnapshot
}

function holdCommit(/* 需要在最终存储提交前暂停一次的工作身份。 */ workId: string) {
  // 在目标工作最终提交前设置一次暂停，用于复现暂停、恢复和提交竞争。
  const original = api.store.commit
  let enter!: () => void, release!: () => void, armed = true
  const entered = new Promise<void>(/* 提交到达断点时完成 entered Promise 的回调。 */ resolve => {
    // 保存提交进入暂停点的通知回调。
    enter = resolve })
  const resumed = new Promise<void>(/* 用例允许提交继续时完成 resumed Promise 的回调。 */ resolve => {
    // 保存放行最终提交的回调，让用例先完成状态变更。
    release = resolve })
  api.store.commit = async (/* 转发给真实存储的待提交图草稿。 */ document, /* 转发给真实存储的预期图版本。 */ revision, /* 转发给真实存储的请求收据。 */ receipt, /* 转发给真实存储、同时用于筛选暂停目标的授权。 */ grant) => {
    // 仅拦截指定授权的第一次提交，随后仍调用真实存储逻辑检验最终条件。
    if (armed && grant?.workId === workId) { armed = false; enter(); await resumed }
    return original(document, revision, receipt, grant)
  }
  return { entered, release, restore() {
    // 放行挂起提交并恢复存储方法，保证用例退出后没有残留钩子。
    release(); api.store.commit = original } }
}

describe('Node-driven shared Runs', () => {
  // 组织范围展开、多节点并行、审核、历史复用及暂停竞争的回归用例。
  it('claims different news and facts, selects saved split candidates, and discovers every new Claim', async () => {
    // 验证不同新闻和事实可同时领取，拆分汇总只保存选中候选，并为每个新事实建立后继核查。
    const a = news('News A'), b = news('News B'), independent = claim('Independent fact')
    const { mapId } = await createMap([a, b, independent])
    const initial = await start(mapId, [a.id, b.id, independent.id])
    expect(initial.run!.operations.map(/* 初始快照中当前投影阶段和目标身份的 Operation。 */ item => /* 投影初始操作阶段与目标身份，核对范围中的每个节点都有独立操作。 */ [item.kind, item.targetId])).toEqual([
      ['split', a.id], ['split', b.id], ['verify', independent.id],
    ])
    const grants = await Promise.all([api.claim(mapId, 'host-a'), api.claim(mapId, 'host-b'), api.claim(mapId, 'host-c')])
    expect(grants.every(Boolean)).toBe(true)
    expect(new Set(grants.map(/* 并发领取结果中当前提取 Operation 身份的授权。 */ item => /* 提取并发授权的操作身份，确认工作分配覆盖不同目标。 */ item!.operationId))).toEqual(new Set(initial.run!.operations.map(/* 初始操作集合中当前提取身份的 Operation。 */ item => /* 提取初始操作身份，作为并发领取的预期集合。 */ item.id)))
    expect(await api.claim(mapId)).toBeNull()
    const splitId = operation(initial, a.id).id
    await route(grants.find(/* 当前与目标拆分 Operation 身份匹配的工作授权。 */ item => /* 找到第一条新闻对应的拆分路由授权。 */ item!.operationId === splitId)!, 2)
    const first = await take(mapId, 'worker', splitId), second = await take(mapId, 'worker', splitId)
    await accept(first, { kind: 'split-report', reason: 'Two candidates', claims: [
      { content: 'Keep the first candidate', category: 'data' }, { content: 'Discard this candidate', category: 'quote' },
    ] })
    await accept(second, { kind: 'split-report', reason: 'Another source', claims: [{ content: 'Keep the second report', category: null }] })
    const merger = await take(mapId, 'merge', splitId)
    const merge = { kind: 'split-merge', reason: 'Select the two relevant claims', reportIds: [first.workId, second.workId],
      selected: [{ reportId: first.workId, index: 0 }, { reportId: second.workId, index: 0 }] }
    const before = await api.snapshot(mapId)
    expectRejected(await api.propose(merger, proposal(merger, { ...merge, selected: [{ reportId: first.workId, index: 99 }] })))
    expect(await api.snapshot(mapId)).toEqual(before)
    const accepted = await accept(merger, merge)
    const outputs = operation(accepted, a.id).outputRefs
    expect(outputs).toHaveLength(2)
    expect(outputs.map(/* 当前根据产物引用查找已保存数据的引用。 */ ref => /* 按产物引用读取已保存节点数据，验证只保存选中的候选事实。 */ accepted.nodes.find(/* 当前与产物引用身份匹配的图节点。 */ node => /* 定位当前产物引用指向的真实节点。 */ node.id === ref.id)!.data)).toEqual([
      { kind: 'claim', content: 'Keep the first candidate', category: 'data' },
      { kind: 'claim', content: 'Keep the second report', category: null },
    ])
    expect(accepted.edges.filter(/* 当前判断是否为目标新闻 mentions 关系的边。 */ edge => /* 筛选第一条新闻到事实的引用关系。 */ edge.kind === 'mentions' && edge.from === a.id).map(/* 目标新闻 mentions 关系中当前提取事实端点的边。 */ edge => /* 提取实际新闻引用指向的事实身份。 */ edge.to)).toEqual(outputs.map(/* 当前提取节点身份的 Operation 产物引用。 */ ref => /* 提取已接受产物身份，与新闻引用关系逐项核对。 */ ref.id))
    expect(accepted.run!.operations).toHaveLength(5)
    const descendants = await Promise.all([api.claim(mapId, 'host-d'), api.claim(mapId, 'host-e')])
    expect(new Set(descendants.map(/* 后继授权中当前提取 Operation 身份的结果。 */ item => /* 收集后继领取的操作身份，验证新事实均进入执行。 */ item!.operationId))).toEqual(new Set(outputs.map(/* 当前根据产物目标查找后继 Operation 的引用。 */ ref => /* 读取每个新事实对应的操作身份，建立后继工作的预期集合。 */ operation(accepted, ref.id).id)))
    expect(await api.claim(mapId)).toBeNull()
  })

  it('keeps an independent news operation executable while another waits for Review', async () => {
    // 验证一条新闻等待审核时另一条仍能执行，所有可运行分支结束后 Run 才进入等待。
    const a = news('Review A'), b = news('Review B')
    const { mapId } = await createMap([a, b])
    const initial = await start(mapId, [a.id, b.id], 'claims', 'human-in-loop')
    const first = await take(mapId, 'router', operation(initial, a.id).id)
    const waiting = await route(first)
    expect(operation(waiting, a.id).status).toBe('waiting')
    expect(waiting.run!.status).toBe('running')
    const second = await take(mapId, 'router', operation(initial, b.id).id)
    expect((await route(second)).run!.status).toBe('waiting')
    await answer(mapId, second.operationId)
    const worker = await take(mapId, 'worker', second.operationId)
    await accept(worker, { kind: 'split-report', reason: 'No checkable claims', claims: [] })
    const merger = await take(mapId, 'merge', second.operationId)
    await accept(merger, { kind: 'split-merge', reason: 'Accept an empty split', reportIds: [worker.workId], selected: [] })
    const finished = await answer(mapId, second.operationId)
    expect(operation(finished, b.id).status).toBe('completed')
    expect(operation(finished, a.id).review).toMatchObject({ kind: 'route', state: 'pending' })
    expect(finished.run!.status).toBe('waiting')
    expect(await api.claim(mapId)).toBeNull()
  })

  it('honors until and scope without expanding a shared Claim back into another news branch', async () => {
    // 验证 until 与显式范围限制后继展开，共享事实可读多来源上下文但不会反向启动其他新闻分支。
    const a = news('Selected news'), b = news('Other source'), shared = claim('Shared fact'), unrelated = claim('Unrelated fact')
    const { mapId } = await createMap([a, b, shared, unrelated], [
      { id: randomUUID(), kind: 'mentions', from: a.id, to: shared.id },
      { id: randomUUID(), kind: 'mentions', from: b.id, to: shared.id },
      { id: randomUUID(), kind: 'related-to', from: a.id, to: b.id },
    ])
    const newsOnly = await start(mapId, [a.id], 'news')
    expect(newsOnly.run).toMatchObject({ status: 'completed', operations: [] })
    expect(await api.claim(mapId)).toBeNull()
    const claimsOnly = await start(mapId, [a.id, shared.id], 'claims')
    expect(claimsOnly.run!.operations.map(/* 只处理到 claims 阶段时当前提取目标身份的 Operation。 */ item => /* 提取仅拆到事实阶段的操作目标，确认事实节点不会继续核查。 */ item.targetId)).toEqual([a.id])
    const router = await take(mapId, 'router')
    await route(router)
    const worker = await take(mapId, 'worker')
    await accept(worker, { kind: 'split-report', reason: 'Only the existing fact applies', claims: [] })
    const merger = await take(mapId, 'merge')
    expect((await accept(merger, { kind: 'split-merge', reason: 'No additional facts', reportIds: [worker.workId], selected: [] })).run!.status)
      .toBe('completed')
    const verifying = await start(mapId, [a.id, shared.id])
    expect(verifying.run!.operations.map(/* 验证历史拆分复用和新核查状态时当前投影的 Operation。 */ item => /* 投影复用拆分与新核查的阶段状态，核对历史复用范围。 */ [item.kind, item.targetId, item.status])).toEqual([
      ['split', a.id, 'completed'], ['verify', shared.id, 'running'],
    ])
    const verification = await take(mapId, 'router', operation(verifying, shared.id).id)
    const data = await api.read(verification)
    expect(new Set(data.context.map((/* 执行上下文中当前提取新闻身份的项。 */ item: { id: string }) => /* 提取执行上下文的来源新闻身份，验证共享事实仍可使用全部相关输入。 */ item.id))).toEqual(new Set([a.id, b.id]))
    expect(await api.claim(mapId)).toBeNull()
    await route(verification)
    const report = await take(mapId, 'worker')
    await accept(report, { kind: 'report', score: 1, reason: 'Verified shared fact' })
    const merge = await take(mapId, 'merge')
    const completed = await accept(merge, { kind: 'merge', reportIds: [report.workId], score: 1, reason: 'Accepted verification' })
    expect(completed.run!.status).toBe('completed')
    const replay = await start(mapId, [a.id, shared.id])
    expect(replay.run!.operations.every(/* 新 Run 中当前确认已通过历史复用完成的 Operation。 */ item => /* 确认再次启动时所有可复用操作直接保持完成。 */ item.status === 'completed')).toBe(true)
    expect(replay.nodes).toEqual(completed.nodes)
    expect(await api.claim(mapId)).toBeNull()
    const output = completed.nodes.find(/* 完成快照中当前判断是否为核查产物的节点。 */ node => /* 找到完成的核查产物，以测试人工改动后历史复用失效。 */ node.data.kind === 'verification')!
    if (output.data.kind !== 'verification') throw new Error('Expected a verification output')
    expect(await api.command('graph.apply', { mapId, expectedRevision: replay.revision,
      changes: { nodes: { put: [{ id: output.id, data: { ...output.data, reason: 'User edited the result' } }] } } }))
      .toMatchObject({ status: 200 })
    expect(operation(await start(mapId, [a.id]), shared.id).status).toBe('running')
  })

  it.each(['parse', 'split'] as const)('persists an empty %s result and reuses it across new Runs', async /* 当前运行空结果复用场景的 parse 或 split 阶段。 */ kind => {
    // 分别验证解析或拆分的空产物会保存成功收据，并可在新 Run 中复用而不重复执行。
    const workspace = await api.createWorkspace(DEFAULT_RUN_CONFIGURATION)
    let input: { id: string; data: GraphNodeData } = news('Nothing to split')
    if (kind === 'parse') {
      const bytes = Buffer.from('No news content')
      const upload = await api.application.assets.upload(api.userToken, { workspaceId: workspace.id, filename: 'empty.txt',
        mediaType: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID(),
      }, Readable.from([bytes]))
      input = { id: randomUUID(), data: { kind: 'source', label: 'Empty source',
        locator: { kind: 'asset', assetId: upload.data.id, mediaType: 'text/plain' } } }
    }
    const { mapId } = await createMap([input], [], workspace)
    await start(mapId, [input.id])
    let done: GraphSnapshot
    if (kind === 'parse') {
      const parser = await take(mapId, 'parse')
      expect((await api.read(parser)).rawContent).toBe('No news content')
      done = await accept(parser, { kind: 'parse', reason: 'No news found', news: [] })
    } else {
      await route(await take(mapId, 'router'))
      const worker = await take(mapId, 'worker')
      await accept(worker, { kind: 'split-report', reason: 'No claims found', claims: [] })
      done = await accept(await take(mapId, 'merge'), { kind: 'split-merge', reason: 'Accept empty result', reportIds: [worker.workId], selected: [] })
    }
    expect(done.run).toMatchObject({ status: 'completed', operations: [{ kind, status: 'completed', outputRefs: [] }] })
    const stored = await api.store.read(mapId)
    expect(stored!.receipts.some(/* 持久化收据中当前检查是否为对应空结果提交的记录。 */ item => /* 检查持久化收据包含本阶段的空结果提交，确认空列表也是真实接纳结果。 */ item.method === `proposal.${kind === 'parse' ? 'parse' : 'split-merge'}`)).toBe(true)
    const again = await start(mapId, [input.id])
    expect(again.run!.id).not.toBe(done.run!.id)
    expect(again.run).toMatchObject({ status: 'completed', operations: [{ kind, status: 'completed', outputRefs: [] }] })
    expect(again.nodes).toEqual(done.nodes)
    expect(await api.claim(mapId)).toBeNull()
  })

  it('revokes unfinished grants across immediate resume and keeps accepted reports and pause replay idempotent', async () => {
    // 暂停后立即恢复，验证旧未完成租约失效、已接受报告保留，重放旧暂停不会再次暂停新状态。
    const target = claim('Pause this fact')
    const { mapId } = await createMap([target])
    await start(mapId, [target.id])
    await route(await take(mapId, 'router'), 2)
    const finished = await take(mapId, 'worker'), old = await take(mapId, 'worker')
    await accept(finished, { kind: 'report', score: 1, reason: 'Already accepted' })
    const late = proposal(old, { kind: 'report', score: 0.5, reason: 'Unfinished angle' })
    const before = await api.snapshot(mapId)
    const requestId = randomUUID(), params = { mapId, expectedRevision: before.revision, runId: before.run.id }
    const paused = await api.command('run.pause', params, requestId)
    expect(paused).toMatchObject({ status: 200, body: { data: { snapshot: { run: { paused: true } } } } })
    expect(await api.claim(mapId)).toBeNull()
    expect(await api.store.readLease(mapId, proof(old))).toBeNull()
    const resumed = await control(mapId, 'run.resume')
    const replacement = await take(mapId, 'worker', old.operationId)
    expect(replacement).toMatchObject({ workId: old.workId, fence: old.fence + 1 })
    expectRejected(await api.work('renew', proof(old)))
    expectRejected(await api.propose(old, late))
    expectRejected(await api.work('fail', { ...proof(old), message: 'Old worker must not fail the resumed Run' }))
    expect((await api.work('release', proof(old))).body.data.released).toBe(false)
    expect(await api.snapshot(mapId)).toEqual(resumed)
    expect(operation(resumed, target.id).reports.map(/* 恢复后当前提取身份以确认已接纳结果保留的报告。 */ item => /* 提取恢复后的报告身份，确认暂停前已完成结果没有丢失。 */ item.id)).toEqual([finished.workId])
    expect(await api.command('run.pause', params, requestId)).toMatchObject({ status: 200, body: { replayed: true } })
    expect(await api.snapshot(mapId)).toEqual(resumed)
    const accepted = await api.propose(replacement, late)
    expect(accepted.status).toBe(200)
    expect(operation(accepted.body.data, target.id).reports).toHaveLength(2)
  })

  it('lets a Review be approved while paused without allowing the operation to execute', async () => {
    // 验证暂停期间可批准审核，但任务仍须显式恢复后才能领取。
    const target = claim('Approve without resuming')
    const { mapId } = await createMap([target])
    const initial = await start(mapId, [target.id], 'verified', 'human-in-loop')
    const router = await take(mapId, 'router')
    await route(router)
    await control(mapId, 'run.pause')
    const answered = await answer(mapId, router.operationId)
    expect(answered.run).toMatchObject({ id: initial.run!.id, status: 'running', paused: true })
    expect(operation(answered, target.id).review).toMatchObject({ state: 'answered', decision: 'approve' })
    expect(await api.claim(mapId)).toBeNull()
    await control(mapId, 'run.resume')
    expect((await take(mapId, 'worker')).operationId).toBe(router.operationId)
  })

  it('fences an in-flight report even when pause and resume both finish before its commit', async () => {
    // 在旧报告最终提交前完成暂停与恢复，验证旧 fence 仍被拒绝而新授权可以提交。
    const target = claim('In-flight report')
    const { mapId } = await createMap([target])
    await start(mapId, [target.id])
    await route(await take(mapId, 'router'))
    const old = await take(mapId, 'worker')
    const data = proposal(old, { kind: 'report', score: 1, reason: 'Late report' })
    const held = holdCommit(old.workId)
    try {
      const pending = api.propose(old, data)
      await held.entered
      await control(mapId, 'run.pause')
      await control(mapId, 'run.resume')
      const replacement = await take(mapId, 'worker', old.operationId)
      held.release()
      expectRejected(await pending)
      const current = await api.snapshot(mapId)
      expect(operation(current, target.id).reports).toEqual([])
      expect(current.run.error).toBeUndefined()
      expect((await api.propose(replacement, data)).status).toBe(200)
    } finally { held.restore() }
  })

  it('rechecks current state before issuing a fresh grant after a pause/resume race', async () => {
    // 在领取前暂停并恢复 Run，验证旧图版本领取失败后会重新读取当前状态再授予租约。
    const target = claim('Fresh lease after resume')
    const { mapId } = await createMap([target])
    await start(mapId, [target.id])
    const original = api.store.claim
    let enter!: () => void, release!: () => void, first = true
    const entered = new Promise<void>(/* 首次领取到达竞态断点时完成 entered Promise 的回调。 */ resolve => {
      // 保存领取进入竞争点的通知回调。
      enter = resolve })
    const held = new Promise<void>(/* 用例允许领取继续时完成 held Promise 的回调。 */ resolve => {
      // 保存继续执行领取的回调，以安排暂停恢复先完成。
      release = resolve })
    const attempts: Array<{ revision: number; claimed: boolean }> = []
    api.store.claim = async (/* 转发给真实 claim 的图、工作、Host、holder 和租约参数。 */ ...args) => {
      // 暂停首个领取并记录各次真实领取使用的版本，验证重试采用新图状态。
      if (first && args[0].id === mapId) { first = false; enter(); await held }
      const result = await original(...args)
      if (args[0].id === mapId) attempts.push({ revision: args[0].revision, claimed: !!result })
      return result
    }
    try {
      const pending = api.claim(mapId, 'resumed-host')
      await entered
      await control(mapId, 'run.pause')
      await control(mapId, 'run.resume')
      const current = await api.snapshot(mapId)
      release()
      expect(await pending).toMatchObject({ hostId: 'resumed-host', fence: 1 })
      expect(attempts[0].claimed).toBe(false)
      expect(attempts.at(-1)).toEqual({ revision: current.revision, claimed: true })
    } finally { release(); api.store.claim = original }
  })

  it('rejects a stale claim while paused and permits fresh acquisition after resume', async () => {
    // 在旧领取暂停期间暂停 Run，验证旧请求返回无工作，恢复后必须重新获取授权。
    const target = claim('Stale claim snapshot')
    const { mapId } = await createMap([target])
    await start(mapId, [target.id])
    const original = api.store.claim
    let enter!: () => void, release!: () => void, armed = true
    const entered = new Promise<void>(/* 旧领取到达暂停点时完成 entered Promise 的回调。 */ resolve => {
      // 保存旧领取到达暂停点的通知。
      enter = resolve })
    const resumed = new Promise<void>(/* 用例允许旧领取继续时完成 resumed Promise 的回调。 */ resolve => {
      // 保存放行旧领取的回调，使其在暂停状态下完成真实检查。
      release = resolve })
    api.store.claim = async (/* 转发给真实 claim 的图、工作、Host、holder 和租约参数。 */ ...args) => {
      // 仅暂停目标图的第一次领取，放行后交回真实存储以验证暂停条件。
      if (armed && args[0].id === mapId) { armed = false; enter(); await resumed }
      return original(...args)
    }
    try {
      const pending = api.claim(mapId, 'stale-host')
      await entered
      await control(mapId, 'run.pause')
      release()
      expect(await pending).toBeNull()
      await control(mapId, 'run.resume')
      expect((await take(mapId, 'router')).hostId).not.toBe('stale-host')
    } finally { release(); api.store.claim = original }
  })
})
