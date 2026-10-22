// Codex最终输出只承载当前阶段的业务提案；授权身份和完整Schema验证仍由宿主与图服务负责。
import type { GraphDataRead } from '../../../contracts/graph-work'
import type { DefinitionRef } from '../../../contracts/data-definition'
import type { GraphCandidateRef } from '../../../contracts/graph-run'
import { promptReadWork, promptReadWorkPersona } from '../dsh/prompt-renderer'

export const CODEX_OUTPUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['proposalJson'],
  properties: { proposalJson: { type: 'string' } } }

export type CodexProposal =
  | { kind: 'outputs'; reason: string; outputs: unknown[] }
  | { kind: 'selection'; reason: string; selection: unknown[] }
  | { kind: 'plan'; reason: string; slots: unknown[] }

interface CodexOutputGuide {
  port: string
  typeRef: DefinitionRef
  allowedSourceKeys: string[]
  candidateReferences: Array<{ path: string; candidates: Array<{ candidate: GraphCandidateRef }> }>
}

enum CodexProposalMessage { INVALID_RESULT = 'Codex没有返回当前冻结阶段的有效提案外壳。' }

export function codexReadProposal(
  /* CLI最终输出文件的完整文本，不是stdout日志或自然语言成功说明。 */ text: string,
  /* 本份冻结工作只允许的一种提案模式。 */ mode: GraphDataRead['outputContract']['mode'],
): CodexProposal {
  // 仅核对外壳和宿主身份边界，未知payload/引用/端口/基数交原后端权威校验。
  let envelope: unknown, proposal: unknown
  try {
    envelope = JSON.parse(text)
    if (!isObject(envelope) || Object.keys(envelope).length !== 1 || typeof envelope.proposalJson !== 'string') throw new Error(CodexProposalMessage.INVALID_RESULT)
    proposal = JSON.parse(envelope.proposalJson)
  } catch { throw new Error(CodexProposalMessage.INVALID_RESULT) }
  if (!isObject(proposal) || proposal.kind !== mode || typeof proposal.reason !== 'string' || !proposal.reason.trim()) throw new Error(CodexProposalMessage.INVALID_RESULT)
  let collection = 'outputs'
  if (mode === 'plan') collection = 'slots'
  else if (mode === 'selection') collection = 'selection'
  if (Object.keys(proposal).some((/* 模型输出的顶层字段。 */ key) => /* 不允许模型提供map/op/spec/proposal身份。 */ !['kind', 'reason', collection].includes(key))) throw new Error(CodexProposalMessage.INVALID_RESULT)
  if (proposal.kind === 'outputs' && Array.isArray(proposal.outputs)) {
    if (proposal.outputs.some((/* 尚未交后端校验的一项候选。 */ output) => /* 正式nodeId只能由服务端分配，payload同名业务字段不受此限制。 */ !isObject(output) || Object.prototype.hasOwnProperty.call(output, 'nodeId'))) throw new Error(CodexProposalMessage.INVALID_RESULT)
    return { kind: 'outputs', reason: proposal.reason, outputs: proposal.outputs }
  }
  if (proposal.kind === 'selection' && Array.isArray(proposal.selection)) return { kind: 'selection', reason: proposal.reason, selection: proposal.selection }
  if (proposal.kind === 'plan' && Array.isArray(proposal.slots)) return { kind: 'plan', reason: proposal.reason, slots: proposal.slots }
  throw new Error(CodexProposalMessage.INVALID_RESULT)
}

export function codexReadPrompt(
  /* 已由工作API核对完整授权身份的冻结视图。 */ data: GraphDataRead,
): string {
  // 复用原冻结变量展开；内部token/holder/fence不进入模型资料或工具参数。
  const persona = promptReadWork(promptReadWorkPersona(data.stage.agent.profile, data), data.libraryClaims)
  return [
    '你执行重明的一份冻结阶段工作。宿主已经完成data_read，且会替你调用data_propose。不要尝试调用DSH工具、执行命令、访问文件或自行提交HTTP。',
    '仅依据下列输入、上下文、固定材料与前序候选给出当前阶段的提案，不执行其它阶段。不确定时明确说明，不编造外部检索或工具调用。',
    persona,
    JSON.stringify({ transitionRef: data.transitionRef, inputs: data.inputs, context: data.context, priorStageResults: data.priorStageResults,
      stage: { id: data.stage.id, slotId: data.stage.slotId, plan: data.stage.plan }, outputContract: data.outputContract,
      outputGuidance: codexReadOutputGuide(data) }, null, 2),
    [
      '执行规范（优先于上方历史提示模板中的旧提案术语）：',
      '最终只输出JSON对象 {"proposalJson":"提案JSON字符串"}，不要Markdown。内层对象必须只有kind、reason和当前outputContract.mode对应的outputs/selection/slots；不得使用旧merge/reportIds等结构。',
      'outputs模式：每项写key、port、outputGuidance中对应端口的精确typeRef、符合outputContract的payload，可选sourceKeys/libraryClaimRefs；不得提供正式nodeId。严格保留JSON字段类型和枚举，例如数字评分不能写成字符串。',
      '前序outputs里的nodeId是服务端预留身份，尚未发布，不可用作opinionIds等字段的普通节点ID字符串。请在outputGuidance.candidateReferences声明的path，复制对应candidate对象 {"candidate":{"workId":"原候选workId","key":"原候选key"}}；后端负责物化真实ID和发布引用闭包。不要自行把对象转为字符串。',
      'sourceKeys可选，不确定时完全省略sourceKeys，不要提交空数组[]。若提供，每项必须来自当前输出端口的allowedSourceKeys。input锚点使用已投影输入的key；output锚点使用对应候选的workId:key。例如verification锚定opinions时，不能使用Claim的inputKey作为来源。',
      'selection模式：selection每项仅包含已有候选的workId和key，不改候选正文。plan模式：slots每项写id、stageId、精确agentRef、angle、hint、priority和tools；只选stage.plan允许的阶段/智能体，tools必须为空数组。',
    ].join('\n'),
  ].join('\n\n')
}

export function codexReadOutputGuide(
  /* 工作服务已授权的输入、直接前序候选和冻结输出合同。 */ data: GraphDataRead,
): CodexOutputGuide[] {
  // 只投影模型可复制的来源键和候选身份，不解析payload Schema或修改模型输出。
  const candidates = data.priorStageResults.flatMap((/* 已获权的直接前序阶段结果。 */ result) =>
    /* 选择/规划不产生新的候选身份。 */ result.mode === 'outputs' ? result.outputs.map((/* 一项真实候选。 */ output) =>
      /* 不向指引暴露预留nodeId，引用以Work与候选键表达。 */ ({ workId: result.workId, key: output.key, port: output.port, typeRef: output.typeRef })) : [])
  const inputs = new Map(Object.entries(data.inputs))
  return data.outputContract.ports.map((/* 当前阶段获准的一份输出端口合同。 */ port) => {
    // 输入锚点与输出锚点分别沿保存合同投影，不能把Claim键误用到Verification。
    const allowedSourceKeys = [...new Set(port.successorOf.flatMap((/* 当前端口允许的一项结构锚点。 */ anchor) =>
      /* 直接前序候选已经由服务端限定，不在前端重算阶段执行资格。 */ anchor.source === 'input'
        ? (inputs.get(anchor.port) ?? []).map((/* 获权输入端口的一项投影。 */ input) => /* 只使用实际自有端口的原精确key。 */ input.key)
        : candidates.filter((/* 一项直接前序候选。 */ candidate) => /* 只允许锚点声明的输出端口。 */ candidate.port === anchor.port)
          .map((/* 该输出端口的可用候选。 */ candidate) => /* 与原服务端sourceKeys组合格式保持一致。 */ `${candidate.workId}:${candidate.key}`)))]
    const candidateReferences = port.references.flatMap((/* 当前输出类型的一项引用声明。 */ reference) => {
      // 只有声明的节点引用位置提供候选对象，资产引用和普通字符串不能冒用。
      if (reference.target.kind !== 'node') return []
      const types = reference.target.types
      return [{ path: reference.path, candidates: candidates.filter((/* 已授权前序候选。 */ candidate) =>
        /* 引用目标类型和版本都须匹配，不拿同名另一版本补齐。 */ types.some((/* 声明允许的精确节点类型。 */ type) =>
          /* 不复制完整Schema验证，仅读保存身份。 */ type.id === candidate.typeRef.id && type.version === candidate.typeRef.version))
        .map((/* 合法引用位置可用的一项候选。 */ candidate) => /* 给模型可直接复制的占位对象，而非预留正式ID。 */ ({ candidate: { workId: candidate.workId, key: candidate.key } })) }]
    })
    return { port: port.port, typeRef: { ...port.type }, allowedSourceKeys, candidateReferences }
  })
}

function isObject(
  /* 来自CLI JSON的未知值。 */ value: unknown,
): value is Record<string, unknown> {
  // 外壳与提案只能是普通JSON对象，不把数组或null当作字段映射。
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
