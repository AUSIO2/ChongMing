// 纯结构夹具只检验验收器，绝不代表真实 Codex 执行或真实新闻核查结果。
import { describe, expect, it } from 'vitest'

import type { GraphNode } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphStageGroup } from '../../contracts/graph-run'
import { codexLiveAssertBranching, CodexLiveBranchingMessage, type CodexLiveBranchingOperation } from './codex-live-branching'

function createFixture(
  /* 各条合成事实的稳定身份，单链用例采用已保存公开摘要中的 Claim ID。 */ claimIds: string[] = ['claim-a', 'claim-b'],
  /* 合成核查角度数，仅用于证明验收器边界，不是模型模拟结果。 */ angleCount = 2,
): { run: { operations: CodexLiveBranchingOperation[] }; snapshot: Pick<GraphSnapshot, 'nodes' | 'edges'>; newsId: string } {
  // 使用真实公开 DTO 的必要字段建立两层分叉，所有提案内容均为显式合成夹具。
  const newsId = '18518c41-8cf8-4bb4-9db2-25280cdd6dfc'
  const nodes: GraphNode[] = []
  const edges: GraphSnapshot['edges'] = []
  function addNode(
    /* 本夹具中的唯一节点身份。 */ id: string,
    /* 默认包中的正式类型名。 */ typeId: string,
    /* 夹具正文；只包含验收器需要的结论引用。 */ payload: GraphNode['payload'] = {},
    /* 对应的合成执行来源。 */ producer?: GraphNode['producer'],
  ): void {
    // 时间和版本固定，方便单独制造串线或边缺失，不启动任何运行时。
    nodes.push({ id, revision: 0, typeId, typeVersion: 1, payload, producer, createdAt: 'fixed', updatedAt: 'fixed' })
  }
  function addEdge(
    /* 合成结构起点。 */ from: string,
    /* 合成结构终点。 */ to: string,
  ): void {
    // 使用真实 successor 类型，reference 不能满足同一断言。
    edges.push({ id: `${from}->${to}`, revision: 0, kind: 'successor', from, to, createdAt: 'fixed', updatedAt: 'fixed' })
  }
  addNode(newsId, 'factcheck.news')
  const operations: CodexLiveBranchingOperation[] = [{ id: 'split', transitionRef: { id: 'factcheck.split-news', version: 1 },
    group: { id: 'split-group', inputRefs: [], contextRefs: [], sealed: true }, stages: [],
    outputRefs: claimIds.map((/* 合成正式事实身份。 */ id) => /* 声明前步已正式发布的身份和版本。 */ ({ id, revision: 0, port: 'claims', workId: 'split-work', key: id })) }]
  for (const claimId of claimIds) {
    addNode(claimId, 'factcheck.claim')
    addEdge(newsId, claimId)
    const operationId = `verify-${claimId}`
    const verificationId = `verification-${claimId}`
    const opinionIds: string[] = []
    const stage: GraphStageGroup = { stageId: 'assess', expectedWorkIds: [], results: [], planSlots: [], closed: true }
    const outputRefs: CodexLiveBranchingOperation['outputRefs'] = []
    for (let index = 0; index < angleCount; index += 1) {
      const opinionId = `opinion-${claimId}-${index}`
      const workId = `work-${claimId}-${index}`
      const slotId = `slot-${index}`
      opinionIds.push(opinionId)
      stage.expectedWorkIds.push(workId)
      stage.results.push({ mode: 'outputs', workId, stageId: 'assess', slotId, acceptedAt: 'fixed', reason: '合成夹具', outputs: [] })
      stage.planSlots.push({ id: slotId, stageId: 'assess', agentRef: { id: `agent-${index}`, version: 0 },
        angle: index === 0 ? '提供材料一致性' : '逻辑与语境限定', hint: '合成夹具', priority: 'medium', tools: [] })
      addNode(opinionId, 'factcheck.opinion', {}, { operationId, transitionRef: { id: 'factcheck.verify-claim', version: 1 },
        stageId: 'assess', workId, agentRef: { id: `agent-${index}`, version: 0 }, agentName: `夹具角度${index}` })
      outputRefs.push({ id: opinionId, revision: 0, port: 'opinions', workId, key: opinionId })
      addEdge(claimId, opinionId)
      addEdge(opinionId, verificationId)
    }
    addNode(verificationId, 'factcheck.verification', { opinionIds }, { operationId,
      transitionRef: { id: 'factcheck.verify-claim', version: 1 }, stageId: 'merge', workId: `merge-${claimId}`,
      agentRef: { id: 'merger', version: 0 }, agentName: '夹具汇总' })
    outputRefs.push({ id: verificationId, revision: 0, port: 'verification', workId: `merge-${claimId}`, key: verificationId })
    operations.push({ id: operationId, transitionRef: { id: 'factcheck.verify-claim', version: 1 },
      group: { id: operationId, sealed: true,
        inputRefs: [{ key: claimId, port: 'claim', id: claimId, revision: 0, type: { id: 'factcheck.claim', version: 1 } }],
        contextRefs: [{ key: newsId, port: 'news', id: newsId, revision: 0, type: { id: 'factcheck.news', version: 1 } }] },
      stages: [stage], outputRefs })
  }
  return { run: { operations }, snapshot: { nodes, edges }, newsId }
}

describe('真实演示的分叉验收器（纯合成结构，不运行模型）', () => {
  it('拒绝已保存新闻验收仅有一个事实和一个角度的单链', () => {
    // 来源：105-codex-live-news-Ts7OdB/summary.json 的公开计数及 News/Claim 身份；保持单链结构。
    const fixture = createFixture(['a734a255-2703-4caf-a11d-c10469cbfb30'], 1)
    expect(() => codexLiveAssertBranching(fixture.run, fixture.snapshot, fixture.newsId))
      .toThrow(CodexLiveBranchingMessage.CLAIM_BRANCHES_REQUIRED)
  })

  it('接受两条正式事实各有两个不同角度、引用及结构边全部闭合', () => {
    const fixture = createFixture()
    expect(() => codexLiveAssertBranching(fixture.run, fixture.snapshot, fixture.newsId)).not.toThrow()
  })

  it('拒绝缺失汇合边或用两个同角度意见冒充双角度', () => {
    const missingEdge = createFixture()
    missingEdge.snapshot.edges.pop()
    expect(() => codexLiveAssertBranching(missingEdge.run, missingEdge.snapshot, missingEdge.newsId))
      .toThrow(CodexLiveBranchingMessage.EDGES_MISMATCH)
    const duplicateAngle = createFixture()
    const slots = duplicateAngle.run.operations[1]?.stages[0]?.planSlots
    if (!slots?.[0] || !slots[1]) throw new Error('合成夹具缺少角度')
    slots[1].angle = slots[0].angle
    expect(() => codexLiveAssertBranching(duplicateAngle.run, duplicateAngle.snapshot, duplicateAngle.newsId))
      .toThrow(CodexLiveBranchingMessage.OPINION_BRANCHES_REQUIRED)
  })

  it('拒绝重复消费同一事实或结论串用另一个事实的意见', () => {
    const wrongInput = createFixture()
    const firstInput = wrongInput.run.operations[1]?.group.inputRefs[0]
    const secondOperation = wrongInput.run.operations[2]
    if (!firstInput || !secondOperation) throw new Error('合成夹具缺少输入')
    secondOperation.group.inputRefs = [{ ...firstInput }]
    expect(() => codexLiveAssertBranching(wrongInput.run, wrongInput.snapshot, wrongInput.newsId))
      .toThrow(CodexLiveBranchingMessage.INPUTS_MISMATCH)
    const wrongOpinion = createFixture()
    const verification = wrongOpinion.snapshot.nodes.find((/* 合成正式节点。 */ node) => /* 第二条事实的结论。 */ node.id === 'verification-claim-b')
    if (!verification) throw new Error('合成夹具缺少结论')
    verification.payload.opinionIds = ['opinion-claim-a-0', 'opinion-claim-a-1']
    expect(() => codexLiveAssertBranching(wrongOpinion.run, wrongOpinion.snapshot, wrongOpinion.newsId))
      .toThrow(CodexLiveBranchingMessage.OPINION_BRANCHES_REQUIRED)
  })
})
