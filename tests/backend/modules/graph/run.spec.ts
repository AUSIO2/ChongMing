// 验证动态核查的路由、报告、汇总和人工审核协议，包括权限与历史重放边界。
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GraphWorkGrant } from '../../../../contracts/graph'
import { createGraphApi, expectRejected, grantHeaders, proof, type TestGraphApi } from '../../fixtures/graph-api'
import { configuredSlots, verificationConfiguration } from '../../fixtures/verification'

let api: TestGraphApi
beforeAll(async () => {
  // 启动真实图服务及独立消息和数据库夹具。
  api = await createGraphApi() }, 30_000)
afterAll(async () => {
  // 释放本文件创建的运行测试资源。
  await api?.close() })

async function route(/* 需要提交路由提案的图身份。 */ mapId: string, /* 测试路由应包含的槽位数量。 */ count: number) {
  // 领取路由角色，按当前配置生成指定数量槽位并提交合法路由。
  const grant = (await api.claim(mapId))!
  expect(grant.actor).toEqual({ role: 'router' })
  const slots = configuredSlots((await api.read(grant)).configuration, count)
  const proposal = await api.proposal(grant, { kind: 'route', reason: 'Select evidence angles', slots })
  const result = await api.propose(grant, proposal)
  expect(result.status).toBe(200)
  return { grant, proposal, slots, snapshot: result.body.data }
}

async function workers(/* 需要领取 Worker 工作的图身份。 */ mapId: string, /* 预期可领取的 Worker 授权数量。 */ count: number) {
  // 为每个报告槽位领取独立 Worker 授权，并确认全部占用后没有额外可领取工作。
  const grants: GraphWorkGrant[] = []
  for (let index = 0; index < count; index++) {
    const grant = (await api.claim(mapId, `worker-${index}`))!
    expect(grant.actor.role).toBe('worker')
    grants.push(grant)
  }
  expect(await api.claim(mapId)).toBeNull()
  return grants
}

async function reports(/* 需要生成并提交报告的 Worker 授权集合。 */ grants: GraphWorkGrant[]) {
  // 为所有授权生成并发报告，提交后逐一断言接纳成功。
  const proposals = await Promise.all(grants.map((/* 当前生成报告提案的 Worker 授权。 */ grant, /* 当前授权在报告集合中的零基序号，用于交替评分。 */ index) => /* 按槽位身份构造独立证据报告，并交替使用不同评分以检验汇总不依赖固定投票。 */ api.proposal(grant, {
    kind: 'report', score: index % 2 ? 0 : 1, reason: `Evidence from ${grant.actor.role === 'worker' ? grant.actor.slotId : '?'}`,
  })))
  const replies = await Promise.all(grants.map((/* 当前提交其预生成提案的 Worker 授权。 */ grant, /* 当前授权在预生成提案数组中的零基位置。 */ index) => /* 使用对应授权并发提交其预先生成的报告提案。 */ api.propose(grant, proposals[index])))
  for (const reply of replies) expect(reply.status).toBe(200)
  return proposals
}

async function merge(/* 需要领取汇总工作并提交结论的图身份。 */ mapId: string, /* 汇总结论的三档评分；默认不确定。 */ score: 0 | 0.5 | 1 = 0.5) {
  // 领取汇总角色并引用全部已接纳报告，提交指定评分的独立汇总结论。
  const grant = (await api.claim(mapId))!
  expect(grant.actor.role).toBe('merge')
  const data = await api.read(grant)
  const proposal = await api.proposal(grant, {
    kind: 'merge', reportIds: data.reports.map((/* 汇总输入中当前提取身份的已接纳报告。 */ report: { id: string }) => /* 提取汇总输入的完整报告身份集合。 */ report.id), score,
    reason: 'Independent merger conclusion, not a fixed vote formula',
  })
  const result = await api.propose(grant, proposal)
  expect(result.status).toBe(200)
  return { grant, proposal, snapshot: result.body.data }
}

describe('Dynamic verification with leased work', () => {
  // 组织动态槽位、角色授权、人工审核及历史幂等行为的运行回归测试。
  it.each([1, 4])('accepts a dynamic %i-slot route and preserves opinions in the explicit merger result', async (/* 当前测试动态路由使用的一槽或四槽数量。 */ count) => {
    // 分别验证单槽和多槽路由可完成核查，最终结论保留每份意见且评分来自显式汇总。
    const context = await api.createRun()
    const routed = await route(context.mapId, count)
    expect(routed.snapshot.run.operations[0].route).toMatchObject({ revision: 1, approved: true, slots: routed.slots })
    const grants = await workers(context.mapId, count)
    const proposals = await reports(grants)
    const before = await api.snapshot(context.mapId)
    expect(before.run.status).toBe('running')
    expect(before.nodes).toHaveLength(1)
    expect(before.run.operations[0].reports).toHaveLength(count)
    const completed = await merge(context.mapId, 0)
    expect(completed.snapshot.run.status).toBe('completed')
    const verification = completed.snapshot.nodes.find((/* 完成快照中当前判断是否为核查结论的节点。 */ node: { data: { kind: string } }) => /* 找到生成的核查结论以检查评分、理由和完整意见。 */ node.data.kind === 'verification')
    expect(verification.data).toMatchObject({ score: 0, reason: completed.proposal.reason,
      reportIds: expect.arrayContaining(proposals.map(/* 当前提取身份以核对结论 reportIds 的报告提案。 */ proposal => /* 提取实际提交的报告身份，确认结论引用全部报告。 */ proposal.id)) })
    expect(verification.data.opinions).toHaveLength(count)
    for (const proposal of proposals) {
      const slot = routed.slots.find(/* 当前与报告提案槽位身份匹配的路由槽位。 */ slot => /* 根据提案槽位取得对应路由角度和工具配置。 */ slot.id === proposal.slotId)!
      const profile = context.configuration.agents.find(/* 当前与槽位绑定身份匹配的冻结 Agent。 */ agent => /* 查找槽位绑定 Agent，核对保存意见中的身份与名称。 */ agent.id === slot.agentId)!
      expect(verification.data.opinions).toContainEqual(expect.objectContaining({
        id: proposal.id, slotId: slot.id, agentId: slot.agentId, agentName: profile.name,
        angle: slot.angle, tools: slot.tools, routeRevision: 1, score: proposal.score, reason: proposal.reason,
      }))
    }
    expect(completed.snapshot.edges).toContainEqual(expect.objectContaining({ kind: 'verifies', from: verification.id, to: context.claimId }))
    expect(await api.claim(context.mapId)).toBeNull()
  })

  it('waits at distinct route and result Reviews and replays accepted decisions without consuming the next Review', async () => {
    // 验证路由与结果各自等待审核，重放已批准决定或成功提案不会误消费下一次审核或推进版本。
    const context = await api.createRun('human-in-loop')
    const routed = await route(context.mapId, 3)
    expect(routed.snapshot.run.operations[0].review).toMatchObject({ kind: 'route', state: 'pending' })
    expect(await api.claim(context.mapId)).toBeNull()
    expect((await api.propose(routed.grant, routed.proposal)).status).toBe(200)
    expectRejected(await api.propose(routed.grant, { ...routed.proposal, reason: 'Changed accepted route' }))
    expectRejected(await api.command('graph.apply', { mapId: context.mapId, expectedRevision: routed.snapshot.revision, changes: { name: 'Blocked' } }))
    const approvedRoute = await api.answer(context.mapId)
    const grants = await workers(context.mapId, 3)
    const acceptedReports = await reports(grants)
    const merged = await merge(context.mapId)
    expect(merged.snapshot.run.operations[0].review).toMatchObject({ kind: 'result', state: 'pending' })
    expect(merged.snapshot.nodes).toHaveLength(1)
    expect(await api.claim(context.mapId)).toBeNull()
    expect((await api.post('/api/v1/command', approvedRoute.body)).body.replayed).toBe(true)
    expect((await api.propose(grants[0], acceptedReports[0])).status).toBe(200)
    expect((await api.propose(merged.grant, merged.proposal)).status).toBe(200)
    expect((await api.snapshot(context.mapId)).revision).toBe(merged.snapshot.revision)
    const approved = await api.answer(context.mapId)
    expect(approved.snapshot.run.status).toBe('completed')
    expect((await api.post('/api/v1/command', approved.body)).body.replayed).toBe(true)
    expect((await api.propose(merged.grant, merged.proposal)).status).toBe(200)
    expect(await api.snapshot(context.mapId)).toEqual(approved.snapshot)
  })

  it('edits a generated verification without losing reports, opinions or edges', async () => {
    // 验证人工编辑已生成结论只更新节点内容，原报告、意见、关系及 Run 状态保持。
    const context = await api.createRun()
    await route(context.mapId, 3)
    await reports(await workers(context.mapId, 3))
    const completed = await merge(context.mapId)
    const original = completed.snapshot.nodes.find((/* 编辑场景中当前定位原核查结论的节点。 */ node: { data: { kind: string } }) => /* 取得原核查结论节点，构造人工修改内容。 */ node.data.kind === 'verification')
    const data = { ...original.data, reason: 'Human clarified the conclusion' }
    expect((await api.command('graph.apply', { mapId: context.mapId, expectedRevision: completed.snapshot.revision,
      changes: { nodes: { put: [{ id: original.id, data }] } },
    })).status).toBe(200)
    const edited = await api.snapshot(context.mapId)
    expect(edited.nodes.find((/* 编辑后快照中当前与原结论身份匹配的节点。 */ node: { id: string }) => /* 按原身份找到编辑后的节点，检查版本递增和内容更新。 */ node.id === original.id)).toMatchObject({ revision: original.revision + 1, data })
    expect(edited.edges).toEqual(completed.snapshot.edges)
    expect(edited.run).toEqual(completed.snapshot.run)
  })

  it('versions a human route edit before making the revised slots claimable', async () => {
    // 验证人工路由编辑推进审核与路由版本，批准前不可领取且旧路由版本报告被拒绝。
    const context = await api.createRun('human-in-loop')
    const routed = await route(context.mapId, 3)
    const old = routed.snapshot.run.operations[0].review
    const slots = configuredSlots(context.configuration, 1)
    slots[0].hint = 'Human-selected evidence'
    const updated = await api.command('review.update', {
      mapId: context.mapId, expectedRevision: routed.snapshot.revision, runId: context.runId,
      operationId: context.operationId, reviewId: old.id, expectedReviewRevision: old.revision, reason: 'One angle is sufficient', slots,
    })
    expect(updated.status).toBe(200)
    const current = updated.body.data.snapshot
    expect(current.run.operations[0].route).toMatchObject({ revision: 2, approved: false, slots })
    expect(await api.claim(context.mapId)).toBeNull()
    expectRejected(await api.command('review.answer', { mapId: context.mapId, expectedRevision: current.revision,
      runId: context.runId, operationId: context.operationId, reviewId: old.id, expectedReviewRevision: old.revision, decision: 'approve' }))
    await api.answer(context.mapId)
    const [grant] = await workers(context.mapId, 1)
    const proposal = await api.proposal(grant, { kind: 'report', score: 1, reason: 'Revised angle' })
    expect(proposal.routeRevision).toBe(2)
    expectRejected(await api.propose(grant, { ...proposal, routeRevision: 1 }))
    expect((await api.propose(grant, proposal)).status).toBe(200)
  })

  it('rejects invalid Agent/tool choices, duplicate slots and routes beyond the frozen limit', async () => {
    // 逐类提交非法槽位、Agent、工具和超限路由，验证拒绝时图不变且合法路由仍可提交。
    const context = await api.createRun('auto', verificationConfiguration(3))
    const grant = (await api.claim(context.mapId))!
    const valid = await api.proposal(grant, { kind: 'route', reason: 'Evidence angles', slots: configuredSlots(context.configuration, 1) })
    const baseline = await api.snapshot(context.mapId)
    const slot = configuredSlots(context.configuration, 1)[0]
    for (const slots of [[{ ...slot, hint: null }], [{ ...slot, priority: 'urgent' }], [{ ...slot, tools: 'ledger_query' }],
      [{ ...slot, extra: true }], [{ ...slot, agentId: 'unknown-agent' }], [{ ...slot, tools: ['unknown_tool'] }],
      [{ ...slot, tools: ['ledger_query'] }], [slot, slot], configuredSlots(context.configuration, 4), []]) {
      expectRejected(await api.propose(grant, { ...valid, slots }))
      expect(await api.snapshot(context.mapId)).toEqual(baseline)
    }
    expect((await api.propose(grant, valid)).status).toBe(200)
  })

  it('requires a grant and derives actor identity from it instead of caller-supplied roles', async () => {
    // 验证执行身份来自精确授权，伪造角色、其他槽位、Agent 字段或错误 Host 凭据均不能提交。
    const context = await api.createRun()
    const query = { mapId: context.mapId, operationId: context.operationId }
    expect((await api.post('/internal/v1/data/read', query)).status).toBe(401)
    expectRejected(await api.post('/internal/v1/data/read', query, {
      authorization: `Bearer ${api.token}`, 'x-dsh-role': 'router',
    }))
    const routed = await route(context.mapId, 3)
    const grants = await workers(context.mapId, 3)
    const first = await api.proposal(grants[0], { kind: 'report', score: 1, reason: 'Evidence' })
    const before = await api.snapshot(context.mapId)
    expectRejected(await api.propose(routed.grant, first))
    expectRejected(await api.propose(grants[1], first))
    expectRejected(await api.propose(grants[0], { ...first, agentId: 'forged-agent' }))
    expectRejected(await api.post('/internal/v1/data/propose', first, { authorization: 'Bearer wrong-token', ...grantHeaders(grants[0]) }))
    expect(await api.snapshot(context.mapId)).toEqual(before)
    expect((await api.propose(grants[0], first)).status).toBe(200)
    expectRejected(await api.propose(grants[1], first))
    expectRejected(await api.propose(routed.grant, first))
    expect((await api.snapshot(context.mapId)).run.operations[0].reports).toHaveLength(1)
  })

  it('does not offer merger work until all reports exist and validates its exact report set', async () => {
    // 验证报告未齐时不提供汇总工作，汇总必须恰好引用完整报告集合并使用正确路由版本。
    const context = await api.createRun()
    await route(context.mapId, 3)
    const grants = await workers(context.mapId, 3)
    const first = await api.proposal(grants[0], { kind: 'report', score: 1, reason: 'First' })
    expectRejected(await api.propose(grants[0], { ...first, routeRevision: 0 }))
    expect((await api.propose(grants[0], first)).status).toBe(200)
    expect(await api.claim(context.mapId)).toBeNull()
    await reports(grants.slice(1))
    const grant = (await api.claim(context.mapId))!
    expect(grant.actor.role).toBe('merge')
    const data = await api.read(grant)
    const ids = data.reports.map((/* 汇总输入中当前提取身份以构造完整集合的报告。 */ report: { id: string }) => /* 提取已接纳报告身份，用于构造缺失、多余和重复引用的非法汇总。 */ report.id)
    const proposal = await api.proposal(grant, { kind: 'merge', score: 0.5, reason: 'Merged', reportIds: ids })
    const before = await api.snapshot(context.mapId)
    for (const reportIds of [ids.slice(1), [...ids, randomUUID()], [ids[0], ...ids]]) expectRejected(await api.propose(grant, { ...proposal, reportIds }))
    expectRejected(await api.propose(grant, { ...proposal, routeRevision: 0 }))
    expectRejected(await api.propose(grants[0], proposal))
    expect(await api.snapshot(context.mapId)).toEqual(before)
    expect((await api.propose(grant, proposal)).status).toBe(200)
  })

  it('keeps accepted proposal identities stable and rejects changed replays', async () => {
    // 验证槽位提案身份稳定，不同槽位隔离，已接纳提案只允许完全相同内容重放。
    const context = await api.createRun()
    await route(context.mapId, 3)
    const grants = await workers(context.mapId, 3)
    const proposal = await api.proposal(grants[0], { kind: 'report', score: 1, reason: 'Evidence' })
    expect((await api.read(grants[0])).proposalId).toBe(proposal.id)
    expect((await api.read(grants[1])).proposalId).not.toBe(proposal.id)
    expectRejected(await api.propose(grants[0], { ...proposal, id: randomUUID() }))
    expect((await api.propose(grants[0], proposal)).status).toBe(200)
    const accepted = await api.snapshot(context.mapId)
    expect((await api.propose(grants[0], proposal)).status).toBe(200)
    expectRejected(await api.propose(grants[0], { ...proposal, reason: 'Changed evidence' }))
    expect(await api.snapshot(context.mapId)).toEqual(accepted)
  })

  it('freezes configuration across separately claimed worker grants', async () => {
    // 修改调用方原配置后分别领取工作，验证本 Run 各授权仍使用启动时的独立配置副本。
    const configuration = verificationConfiguration()
    const context = await api.createRun('auto', configuration)
    const frozen = structuredClone(context.configuration)
    configuration.agents[0].content = 'Later edits'
    configuration.agents[0].tools = []
    const routed = await route(context.mapId, 3)
    expect((await api.read(routed.grant)).configuration).toEqual(frozen)
    const grants = await workers(context.mapId, 3)
    for (const grant of grants) expect((await api.read(grant)).configuration).toEqual(frozen)
    const current = await api.snapshot(context.mapId)
    expectRejected(await api.command('run.start', { mapId: context.mapId, expectedRevision: current.revision,
      id: randomUUID(), scope: { nodeIds: [context.claimId] }, until: 'verified', regenerate: true, mode: 'auto' }))
  })

  it('confirms an accepted historical merge after a new Run starts without accepting unsubmitted old work', async () => {
    // 启动新 Run 后允许确认历史已接纳汇总，但拒绝旧 Run 尚未提交的报告。
    const first = await api.createRun()
    await route(first.mapId, 1)
    await reports(await workers(first.mapId, 1))
    const accepted = await merge(first.mapId)
    const nextId = randomUUID()
    expect((await api.command('run.start', { mapId: first.mapId, expectedRevision: accepted.snapshot.revision,
      id: nextId, scope: { nodeIds: [first.claimId] }, until: 'verified', regenerate: true, mode: 'auto' })).status).toBe(200)
    const beforeReplay = await api.snapshot(first.mapId)
    expect((await api.propose(accepted.grant, accepted.proposal)).status).toBe(200)
    expect(await api.snapshot(first.mapId)).toEqual(beforeReplay)
    await route(first.mapId, 1)
    const [unsubmitted] = await workers(first.mapId, 1)
    const proposal = await api.proposal(unsubmitted, { kind: 'report', score: 1, reason: 'Late' })
    const current = await api.snapshot(first.mapId)
    const cancelled = await api.command('run.cancel', { mapId: first.mapId, expectedRevision: current.revision, runId: nextId })
    expect(cancelled.status).toBe(200)
    expect((await api.command('run.start', { mapId: first.mapId, expectedRevision: cancelled.body.data.snapshot.revision,
      id: randomUUID(), scope: { nodeIds: [first.claimId] }, until: 'verified', regenerate: true, mode: 'auto' })).status).toBe(200)
    const newest = await api.snapshot(first.mapId)
    expectRejected(await api.propose(unsubmitted, proposal))
    expect((await api.propose(accepted.grant, accepted.proposal)).status).toBe(200)
    expect(await api.snapshot(first.mapId)).toEqual(newest)
  })

  it('returns the persisted winning IDs from concurrent identical result approvals', async () => {
    // 并发批准同一结果审核，验证两次响应返回实际获胜提交的相同节点与关系身份。
    const context = await api.createRun('human-in-loop')
    await route(context.mapId, 1)
    await api.answer(context.mapId)
    await reports(await workers(context.mapId, 1))
    const merged = await merge(context.mapId)
    const review = merged.snapshot.run.operations[0].review
    const body = { requestId: randomUUID(), method: 'review.answer', params: { mapId: context.mapId,
      expectedRevision: merged.snapshot.revision, runId: context.runId, operationId: context.operationId, reviewId: review.id,
      expectedReviewRevision: review.revision, decision: 'approve' } }
    // 用户和令牌授权栅栏可能在请求到达图版本比较之前就将两次请求串行化。
    {
      const replies = await Promise.all([api.post('/api/v1/command', body), api.post('/api/v1/command', body)])
      expect(replies.map(/* 并发审核响应中当前提取 HTTP 状态码的结果。 */ reply => /* 提取并发批准状态码，确认两次请求都成功确认结果。 */ reply.status)).toEqual([200, 200])
      expect(replies.map(/* 并发审核响应中当前提取重放标记的结果。 */ reply => /* 提取重放标记，确认只有一项执行了实际发布。 */ reply.body.replayed).sort()).toEqual([false, true])
      const winner = replies.find(/* 并发审核响应中当前判断是否为实际获胜提交的结果。 */ reply => /* 找到非重放的获胜响应，作为所有返回产物身份的基准。 */ !reply.body.replayed)!.body.data
      expect(winner.createdNodeIds).toHaveLength(1)
      expect(winner.createdEdgeIds).toHaveLength(1)
      for (const reply of replies) {
        expect(reply.body.data.createdNodeIds).toEqual(winner.createdNodeIds)
        expect(reply.body.data.createdEdgeIds).toEqual(winner.createdEdgeIds)
        expect(reply.body.data.snapshot.nodes.map((/* 响应快照中当前提取身份以核对创建节点的项。 */ node: { id: string }) => /* 收集响应快照中的节点身份，确认包含获胜提交创建的节点。 */ node.id)).toEqual(expect.arrayContaining(winner.createdNodeIds))
        expect(reply.body.data.snapshot.edges.map((/* 响应快照中当前提取身份以核对创建关系的项。 */ edge: { id: string }) => /* 收集响应快照中的关系身份，确认和获胜提交返回的关系一致。 */ edge.id)).toEqual(winner.createdEdgeIds)
      }
    }
  })

  it('cancels outstanding grants and refuses to resurrect a used Run id', async () => {
    // 取消 Run 后验证旧报告与续租被拒绝、无工作可领，且不能复用曾使用的 Run 身份。
    const context = await api.createRun()
    await route(context.mapId, 1)
    const [grant] = await workers(context.mapId, 1)
    const late = await api.proposal(grant, { kind: 'report', score: 1, reason: 'Late report' })
    const current = await api.snapshot(context.mapId)
    const cancelled = await api.command('run.cancel', { mapId: context.mapId, expectedRevision: current.revision, runId: context.runId })
    expect(cancelled.status).toBe(200)
    expectRejected(await api.propose(grant, late))
    expectRejected(await api.work('renew', proof(grant)))
    expect(await api.claim(context.mapId)).toBeNull()
    expectRejected(await api.command('run.start', { mapId: context.mapId, expectedRevision: cancelled.body.data.snapshot.revision,
      id: context.runId, scope: { nodeIds: [context.claimId] }, until: 'verified', regenerate: true, mode: 'auto' }))
  })
})
