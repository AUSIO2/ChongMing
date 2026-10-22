// 仅检查显式真实模型演示的分叉验收；不改变普通 Run 的后端合同。
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphOperation } from '../../contracts/graph-run'

export type CodexLiveBranchingOperation = Pick<GraphOperation, 'id' | 'transitionRef' | 'group' | 'stages' | 'outputRefs'>

export enum CodexLiveBranchingMessage {
  CLAIM_BRANCHES_REQUIRED = '树状演示没有形成所需的正式事实分支。',
  INPUTS_MISMATCH = '核查输入没有精确覆盖拆分的正式事实和原新闻上下文。',
  OPINION_BRANCHES_REQUIRED = '事实没有形成所需的不同核查角度并被正式结论引用。',
  EDGES_MISMATCH = '正式分叉或汇合关系不闭合。',
}

export class CodexLiveBranchingError extends Error {
  constructor(/* 本验收器定义的固定失败类别，不接受模型正文。 */ readonly check: CodexLiveBranchingMessage) {
    super(check)
    this.name = 'CodexLiveBranchingError'
  }
}

export function codexLiveAssertBranching(
  /* 已由公共 API 独立读取的实际处理记录。 */ run: { operations: readonly CodexLiveBranchingOperation[] },
  /* 同一图保存的正式节点和结构关系。 */ snapshot: Pick<GraphSnapshot, 'nodes' | 'edges'>,
  /* 本次通过页面创建的原新闻身份。 */ newsId: string,
): void {
  // 这里只核对树状演示的实际结构，不推断新闻含义，也不生成或补齐任何产物。
  const news = snapshot.nodes.find((/* 正式图节点。 */ node) => /* 固定原输入。 */ node.id === newsId)
  const splitOperations = run.operations.filter((/* 实际处理项。 */ operation) =>
    /* 精确采用默认新闻拆分转换。 */ operation.transitionRef.id === 'factcheck.split-news' && operation.transitionRef.version === 1)
  const claims = splitOperations.flatMap((/* 拆分正式发布记录。 */ operation) =>
    /* 仅消费已发布 claims 端口，不计候选或其它类型。 */ operation.outputRefs.filter(
      (/* 正式输出身份。 */ ref) => /* 本演示的结构后继端口。 */ ref.port === 'claims',
    ))
  if (!news || splitOperations.length !== 1 || claims.length < 2
    || new Set(claims.map((/* 正式拆分输出。 */ ref) => /* 重复身份不能冒充另一条事实。 */ ref.id)).size !== claims.length) {
    throw new CodexLiveBranchingError(CodexLiveBranchingMessage.CLAIM_BRANCHES_REQUIRED)
  }
  const verificationOperations = run.operations.filter((/* 实际处理项。 */ operation) =>
    /* 与每个正式事实对应的默认核查转换。 */ operation.transitionRef.id === 'factcheck.verify-claim' && operation.transitionRef.version === 1)
  const consumed = verificationOperations.flatMap((/* 每条事实的独立核查。 */ operation) =>
    /* 精确比较 ID、内容版本和端口，不能用多消费同一事实冒充多分支。 */ operation.group.inputRefs.map(
      (/* 后端保存的冻结输入。 */ ref) => /* 保留实际内容版本。 */ `${ref.id}@${ref.revision}:${ref.port}`,
    )).sort()
  const expected = claims.map((/* 拆分正式产物。 */ ref) => /* 默认下步绑定 claim 输入端口。 */ `${ref.id}@${ref.revision}:claim`).sort()
  if (verificationOperations.length !== claims.length || JSON.stringify(consumed) !== JSON.stringify(expected)) {
    throw new CodexLiveBranchingError(CodexLiveBranchingMessage.INPUTS_MISMATCH)
  }
  function hasEdge(
    /* 结构起点的正式节点身份。 */ from: string,
    /* 结构终点的正式节点身份。 */ to: string,
  ): boolean {
    // 引用边不能代替默认转换声明的后继边。
    return snapshot.edges.some((/* 保存的关系。 */ edge) => /* 精确验证结构方向。 */ edge.kind === 'successor' && edge.from === from && edge.to === to)
  }
  for (const claim of claims) {
    const operation = verificationOperations.find((/* 已保存核查处理。 */ item) =>
      /* 一个默认核查组只接受一条事实。 */ item.group.inputRefs.length === 1 && item.group.inputRefs[0]?.id === claim.id)
    const contexts = operation?.group.contextRefs
    if (!operation || !contexts || contexts.length !== 1 || contexts[0]?.port !== 'news'
      || contexts[0].id !== newsId || contexts[0].revision !== news.revision) throw new CodexLiveBranchingError(CodexLiveBranchingMessage.INPUTS_MISMATCH)
    const opinions = snapshot.nodes.filter((/* 正式节点。 */ node) =>
      /* 只计属于当前 Claim 对应处理的正式意见。 */ node.typeId === 'factcheck.opinion' && node.producer?.operationId === operation.id)
    const verifications = snapshot.nodes.filter((/* 正式节点。 */ node) =>
      /* 一个默认核查处理只产生一个结论。 */ node.typeId === 'factcheck.verification' && node.producer?.operationId === operation.id)
    const verification = verifications[0]
    const referenced = verification?.payload.opinionIds
    const opinionIds = opinions.map((/* 当前处理的正式意见。 */ node) => /* 排除其它事实的意见。 */ node.id).sort()
    if (opinions.length < 2 || verifications.length !== 1 || !verification || !Array.isArray(referenced)
      || JSON.stringify([...referenced].sort()) !== JSON.stringify(opinionIds)) throw new CodexLiveBranchingError(CodexLiveBranchingMessage.OPINION_BRANCHES_REQUIRED)
    const angles = opinions.map((/* 当前结论实际引用的正式意见。 */ opinion) => {
      // 角度来自生成该意见的真实 Work 所属批准槽位，不按意见正文或 Agent 名猜测。
      const producer = opinion.producer
      const stage = operation.stages.find((/* 当前处理的实际阶段。 */ item) => /* 与保存的创建来源一致。 */ item.stageId === producer?.stageId)
      const result = stage?.results.find((/* 后端接纳结果。 */ item) => /* 正式意见必须能指回生成工作。 */ item.workId === producer?.workId)
      const slot = stage?.planSlots.find((/* 已批准的执行角度。 */ item) => /* 按结果的实际 slotId 关联。 */ item.id === result?.slotId)
      return slot?.angle.trim() ?? ''
    })
    if (angles.some((/* 单个正式意见对应的角度。 */ angle) => /* 无法定位的来源不能计入分叉。 */ !angle)
      || new Set(angles).size < 2) throw new CodexLiveBranchingError(CodexLiveBranchingMessage.OPINION_BRANCHES_REQUIRED)
    if (!hasEdge(newsId, claim.id)) throw new CodexLiveBranchingError(CodexLiveBranchingMessage.EDGES_MISMATCH)
    for (const opinion of opinions) {
      if (!hasEdge(claim.id, opinion.id) || !hasEdge(opinion.id, verification.id)) throw new CodexLiveBranchingError(CodexLiveBranchingMessage.EDGES_MISMATCH)
    }
  }
}
