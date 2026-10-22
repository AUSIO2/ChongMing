// 仅按服务端已有创建元数据区分来源，不把历史缺省producer推断为人工创建。
import type { GraphNode } from '../../../../contracts/graph'
import type { GraphOperation, GraphRun } from '../../../../contracts/graph-run'

// Map与工作区由历史面板固定；这里仅携带一次只读来源定位所需的保存记录。
export type OperationOriginTarget =
  | { kind: 'producer'; operationId: string; node: Pick<GraphNode, 'id' | 'revision' | 'typeId' | 'typeVersion' | 'producer'> }
  | { kind: 'reuse'; operationId: string; source: Pick<GraphOperation, 'id' | 'transitionRef' | 'specHash' | 'outputRefs'> }

// 跨页面组件转发时保留实际来源所在图，不能借后来选中的活动图身份。
export interface OperationOriginOpen { workspaceId: string; mapId: string; target: OperationOriginTarget }

interface ProvenanceRow { label: string; value: string }

export interface NodeProvenance {
  label: ReturnType<typeof nodeReadOrigin>
  rows: ProvenanceRow[]
  packageRows?: ProvenanceRow[]
  target: OperationOriginTarget | null
}

export function nodeReadOrigin(
  /* 原节点或保留来源元数据的固定快照；导入来源优先于包内旧生成和人工记录。 */
  node: Pick<GraphNode, 'importedFrom' | 'producer' | 'manualOrigin'>,
): '人工创建' | '自动生成' | '导入' | '来源未知' {
  // 编辑不会重写创建来源，缺少明确元数据的历史节点保持未知。
  if (node.importedFrom) return '导入'
  if (node.producer) return '自动生成'
  if (node.manualOrigin) return '人工创建'
  return '来源未知'
}

export function provenanceReadNode(
  /* 当前真实阅读的保存节点，正文编辑不改变创建元数据。 */ node: GraphNode,
): NodeProvenance {
  // 投影保存来源与固定导航意图；导入包内记录不会生成本地图运行链接。
  const label = nodeReadOrigin(node)
  if (node.importedFrom) {
    const packageRows = [
      ...(node.producer ? readProducerRows(node.producer) : []),
      ...(node.manualOrigin ? [{ label: '创建用户', value: node.manualOrigin.userId }] : []),
    ]
    return { label, rows: [
      { label: '数据包', value: node.importedFrom.bundleId },
      { label: '原节点', value: node.importedFrom.nodeId },
      { label: '原版本', value: String(node.importedFrom.revision) },
    ], ...(packageRows.length ? { packageRows } : {}), target: null }
  }
  if (node.producer) return { label, rows: [...readProducerRows(node.producer), { label: '创建时间', value: node.createdAt }],
    target: { kind: 'producer', operationId: node.producer.operationId, node: {
      id: node.id, revision: node.revision, typeId: node.typeId, typeVersion: node.typeVersion,
      producer: { ...node.producer, transitionRef: { ...node.producer.transitionRef }, agentRef: { ...node.producer.agentRef } },
    } } }
  if (node.manualOrigin) return { label, rows: [
    { label: '创建用户', value: node.manualOrigin.userId }, { label: '创建时间', value: node.createdAt },
  ], target: null }
  return { label, rows: [{ label: '来源说明', value: '未保存创建来源信息' }], target: null }
}

export function provenanceMatchOperation(
  /* 精确目录查得的一份保存运行，不读取当前节点正文。 */ run: GraphRun,
  /* 发起导航时固定的节点生成或直接复用来源。 */ target: OperationOriginTarget,
): { ok: true; operation: GraphOperation; outputRevision?: number } | { ok: false } {
  // 只核对已保存身份和产物映射，不重新判断复用可执行性或计算发布选择。
  const operations = run.operations.filter((/* 保存的处理项。 */ operation) =>
    /* 同一精确ID只能对应一份记录。 */ operation.id === target.operationId)
  const operation = operations[0]
  if (operations.length !== 1 || !operation || operation.status !== 'completed') return { ok: false }
  if (target.kind === 'reuse') {
    const source = target.source
    if (operation.transitionRef.id !== source.transitionRef.id || operation.transitionRef.version !== source.transitionRef.version
      || operation.specHash !== source.specHash || !haveSameOutputs(operation.outputRefs, source.outputRefs)) return { ok: false }
    return { ok: true, operation }
  }
  const { node } = target
  const producer = node.producer
  if (!producer || producer.operationId !== target.operationId || operation.transitionRef.id !== producer.transitionRef.id
    || operation.transitionRef.version !== producer.transitionRef.version) return { ok: false }
  const outputs = operation.outputRefs.filter((/* 保存的正式产物映射。 */ output) =>
    /* 节点身份唯一，当前revision允许比产出时更新。 */ output.id === node.id)
  const output = outputs[0]
  if (outputs.length !== 1 || !output || output.workId !== producer.workId) return { ok: false }
  const candidates = operation.stages.flatMap((/* 保存的阶段组。 */ group) =>
    /* 读取接纳候选的work/key，不把selection当新生成正文。 */ group.results.flatMap((/* 阶段内接纳结果。 */ result) =>
      /* 精确Work的同名候选只能存在一次。 */ result.mode === 'outputs' && result.workId === output.workId
        ? result.outputs.filter((/* 接纳候选。 */ candidate) => /* 正式产物保存的候选键。 */ candidate.key === output.key)
          .map((/* 已按候选键匹配的输出。 */ candidate) => /* 保留组与结果阶段供对应检查。 */ ({ group, result, candidate }))
        : []))
  const match = candidates[0]
  if (candidates.length !== 1 || !match || match.group.stageId !== producer.stageId || match.result.stageId !== producer.stageId
    || match.candidate.port !== output.port || match.candidate.typeRef.id !== node.typeId || match.candidate.typeRef.version !== node.typeVersion
    || (match.candidate.nodeId !== undefined && match.candidate.nodeId !== node.id)) return { ok: false }
  return { ok: true, operation, outputRevision: output.revision }
}

function readProducerRows(
  /* 原节点或导入包内保留的生成元数据。 */ producer: NonNullable<GraphNode['producer']>,
): ProvenanceRow[] {
  // 只显示生成时保存的智能体名称和版本，不替换为当前目录配置。
  return [
    { label: '转换', value: `${producer.transitionRef.id} · v${producer.transitionRef.version}` },
    { label: '智能体', value: `${producer.agentName} · ${producer.agentRef.id} · v${producer.agentRef.version}` },
    { label: '阶段', value: producer.stageId }, { label: '处理项', value: producer.operationId }, { label: '工作项', value: producer.workId },
  ]
}

function haveSameOutputs(
  /* 查得的直接来源保存产物。 */ left: GraphOperation['outputRefs'],
  /* 复用记录复制的保存产物。 */ right: GraphOperation['outputRefs'],
): boolean {
  // 对照完整映射集合，不因展示顺序不同拒绝同一批保存产物。
  if (left.length !== right.length) return false
  const keys = (/* 一份保存映射列表。 */ outputs: GraphOperation['outputRefs']): string[] =>
    /* 字段固定顺序编码并排序，不修改输入数组。 */ outputs.map((/* 单份正式产物。 */ output) =>
      /* 包含revision，防止把同节点后来的编辑视为复制产物。 */ JSON.stringify([output.id, output.revision, output.port, output.workId, output.key])).sort()
  const leftKeys = keys(left)
  const rightKeys = keys(right)
  return leftKeys.every((/* 左侧排序后的映射身份。 */ value, /* 对应右侧位置。 */ index) =>
    /* 重复项也保留计数，不做无依据的去重。 */ value === rightKeys[index])
}
