// 协调通用数据图命令、有限 Run、幂等收据和逐 Work 租约，将合法局部变化原子提交到存储。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import type { DefinitionCatalog, DefinitionRef } from '../../../contracts/data-definition'
import type {
  GraphBranchClaimResult,
  GraphBranchGrant,
  GraphBranchLeaseProof,
  GraphBranchSnapshot,
  GraphRunControl,
  GraphRunControlClaimResult,
  GraphRunControlGrant,
  GraphRunControlProof,
} from '../../../contracts/graph-branch'
import type { GraphChanges, GraphEdge, GraphNode } from '../../../contracts/graph'
import type {
  GraphCommand,
  GraphMapSummary,
  GraphQuery,
  GraphSnapshot,
  GraphWriteResult,
} from '../../../contracts/graph-api'
import type {
  GraphDataProposal,
  GraphDataRead,
  GraphWorkCommand,
  GraphWorkGrant,
  GraphWorkProof,
} from '../../../contracts/graph-work'
import type { GraphPublicationPreview, GraphRun, GraphRunPage } from '../../../contracts/graph-run'
import type { GraphClaimResult } from '../../../contracts/events'
import type { GraphCommitGuard, GraphStore } from '../../ports/graph-store'
import { definitionsReadType, type PayloadReferenceValue } from '../shared/data-definition'
import { GraphError } from '../shared/domain-error'
import {
  runAnswerReview, runCancelRun, runCreateRun, runReadData, runReadWorkContext, runReadOperation, runReadPublicationPreview, runReadRun, runUpdatePause, runUpdateProposal,
  type GraphRunStartContext,
} from './run-state'
import { storeCreateInputHash, type GraphBranchOwnershipRecord, type GraphDocument, type GraphOwnershipReceipt, type GraphReceipt, type GraphRunControlRecord } from './graph-record'
import { workReadGrant, workReadItems } from './work-state'
import { branchFindOwnershipConflict, branchPruneOwnerships, branchReadOwnerships, branchReadSnapshot, branchValidateMutation, branchValidateNewRoots } from './branch-state'
import { graphParseNodePayload, graphParseNodes, type ParsedGraphNode } from '../shared/data-reference-index'
import { graphValidateSourceAnchors } from '../shared/source-anchors'
import { graphInputReadLibraryUseRefs } from './library-claim-input'
import { graphReadRunPage } from './run-history'

type GraphEditorOwnershipRecord = Extract<GraphBranchOwnershipRecord, { kind: 'editor' }>

/**
 * 租约、内部收据和历史 Run 不进入公开快照；节点已经保存可信 producer 投影。
 *
 * @param document 包含通用节点、关系和当前运行状态的持久化图。
 * @param now 用于过滤过期 editor 的当前时间。
 * @param clientLeasesRequired 本机不展示此前存储的客户端租约。
 */
export function graphReadSnapshot(document: GraphDocument, now = Date.now(),
  clientLeasesRequired = true): GraphSnapshot {
  return { mapId: document.id, workspaceId: document.workspaceId, revision: document.revision, name: document.name,
    nodes: structuredClone(document.nodes), edges: structuredClone(document.edges), runs: structuredClone(document.runs),
    ownershipRevision: document.ownershipRevision ?? 0, ownerships: branchReadOwnerships(document, now).filter(item => clientLeasesRequired || item.kind === 'run'),
    runControls: clientLeasesRequired ? graphReadRunControls(document, now) : [], updatedAt: document.updatedAt }
}

/**
 * @param document 当前图。
 * @param now 存储端当前时间。
 */
function graphReadRunControls(document: GraphDocument, now: number): GraphRunControl[] {
  return Object.values(document.branchOwnerships ?? {}).filter((item): item is GraphRunControlRecord => item.kind === 'control'
    && Date.parse(item.expiresAt) > now && document.runs.some(run => run.id === item.runId && ['running', 'waiting'].includes(run.status)))
    .map(item => { const { kind: _kind, ...control } = structuredClone(item); return control })
}

/**
 * 相同身份只有方法和输入摘要也相同才可重放，避免将新意图误认为旧成功。
 *
 * @param document 当前图及其已接受收据。
 * @param requestId 幂等身份。
 * @param method 公共命令或内部动作。
 * @param inputHash 当前输入的稳定摘要。
 */
function graphReadReceipt(document: GraphDocument, requestId: string,
  method: string, inputHash: string): GraphReceipt | null {
  const receipt = document.receipts.find(item => item.requestId === requestId)
  if (!receipt) return null
  if (receipt.method !== method || receipt.inputHash !== inputHash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_WAS_ALREADY_USED_WITH_DIFFERENT_INPUT)
  return receipt
}

/**
 * 收据与业务状态同次提交，响应丢失后可返回同一组正式身份。
 *
 * @param requestId 业务动作的幂等身份。
 * @param method 收据动作。
 * @param inputHash 输入摘要。
 * @param now 服务端时间。
 * @param createdNodeIds 新建节点。
 * @param createdEdgeIds 新建关系。
 * @param branch 分支写入成功时固定的提交后范围与版本。
 */
function graphCreateReceipt(requestId: string, method: string,
  inputHash: string, now: string, createdNodeIds: string[] = [],
  createdEdgeIds: string[] = [], branch?: GraphBranchSnapshot): GraphReceipt {
  return { requestId, method, inputHash, createdNodeIds, createdEdgeIds, ...(branch ? { branch: structuredClone(branch) } : {}), createdAt: now }
}

/**
 * 当前快照反映最新状态；只有仍与该快照同次的分支证明才返回，避免把旧 receipt proof 拼到新快照上。
 *
 * @param document 提交或重放后的当前图。
 * @param receipt 对应已接受收据。
 * @param runControl run.start 同次取得的控制权。
 * @param clientLeasesRequired 服务端客户端租约策略。
 */
function graphCreateWriteResult(
  /* 提交成功或确认重放后的当前图文档。 */ document: GraphDocument,
  /* 绑定本次已接受操作及其可选分支证明的收据。 */ receipt: GraphReceipt,
  /* run.start 与启动动作同次取得的可选控制授权。 */ runControl?: GraphRunControlGrant,
  /* 本次服务是否要求向客户端提供编辑与控制租约。 */ clientLeasesRequired = true,
): GraphWriteResult {
  // 仅在收据与当前内容版本一致时返回仍然匹配的分支证明。
  let branch: GraphBranchSnapshot | undefined
  if (receipt.branch && receipt.branch.mapRevision === document.revision) {
    const current = branchReadSnapshot(document, receipt.branch.scope.rootIds)
    if (current.version === receipt.branch.version) branch = receipt.branch
  }
  return { snapshot: graphReadSnapshot(document, Date.now(), clientLeasesRequired), createdNodeIds: receipt.createdNodeIds, createdEdgeIds: receipt.createdEdgeIds,
    ...(branch ? { branch: structuredClone(branch) } : {}), ...(runControl ? { runControl: structuredClone(runControl) } : {}) }
}

/**
 * 同一补丁中的重复身份含义不清，必须在修改图前拒绝。
 *
 * @param values 待拒绝重复的身份。
 * @param label 错误字段名。
 */
function graphReadUnique(values: string[], label: string): Set<string> {
  const ids = new Set(values)
  if (ids.size !== values.length) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTAINS_DUPLICATE_IDS, label))
  return ids
}

/**
 * 将实例字段组合成目录引用。
 *
 * @param node 数据实例的精确类型。
 */
function graphRef(node: Pick<GraphNode, 'typeId' | 'typeVersion'>): DefinitionRef {
  return { id: node.typeId, version: node.typeVersion }
}

/**
 * successor 必须被上游精确类型版本许可；reference 不进入此规则。
 *
 * @param definitions 精确定义目录。
 * @param from 上游数据。
 * @param to 正式产物。
 */
function graphValidateSuccessor(definitions: DefinitionCatalog, from: GraphNode, to: GraphNode): void {
  const definition = definitionsReadType(definitions, graphRef(from))
  if (!definition.successorTypes.some(ref => ref.id === to.typeId && ref.version === to.typeVersion)) {
    throw new GraphError(422, 'TRANSITION_NOT_ALLOWED', RuntimeMessage.GRAPH_SUCCESSOR_TYPE_IS_NOT_ALLOWED)
  }
}

/**
 * successor 定义结构分支并保持无环；reference 允许普通关系环。
 *
 * @param nodes 修改后的节点索引。
 * @param edges 修改后的关系索引。
 */
function graphValidateSuccessorAcyclic(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): void {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges.values()) if (edge.kind === 'successor') {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new GraphError(422, 'INVALID_RELATION', RuntimeMessage.EDGE_REFERENCES_A_MISSING_NODE)
    const children = outgoing.get(edge.from) ?? []
    children.push(edge.to); outgoing.set(edge.from, children)
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new GraphError(422, 'INVALID_RELATION', RuntimeMessage.SUCCESSOR_RELATIONS_MUST_NOT_CONTAIN_A_CYCLE)
    if (visited.has(id)) return
    visiting.add(id)
    for (const child of outgoing.get(id) ?? []) visit(child)
    visiting.delete(id); visited.add(id)
  }
  for (const id of nodes.keys()) visit(id)
}

/**
 * 用户修改或删除节点后，所有声明的节点引用都必须仍存在且匹配允许类型版本。
 *
 * @param nodes 修改后的完整节点索引。
 * @param references 与当前节点正文同次解析的实际引用。
 */
function graphValidateNodeReferences(
  /* 本次修改后实际存在的节点，用于裁决引用目标及类型。 */ nodes: Map<string, GraphNode>,
  /* 与这些节点的已验证正文同次展开的引用。 */ references: readonly PayloadReferenceValue[],
): void {
  // 只裁决引用目标是否仍存在且类型获准，不重新解析已经验证的正文。
  for (const reference of references) {
    if (reference.definition.target.kind !== 'node') continue
    const target = nodes.get(reference.value)
    if (!target || !reference.definition.target.types.some(type => type.id === target.typeId && type.version === target.typeVersion)) {
      throw new GraphError(422, 'OUTPUT_REFERENCE_INVALID', RuntimeMessage.GRAPH_NODE_REFERENCE_IS_NOT_VALID)
    }
  }
}

/**
 * 应用局部变化，按定义验证 payload/后继及结构无环，返回待提交草稿。
 *
 * @param document 修改前的当前图。
 * @param initialNodes 本次 attempt 在证明检查前已解析的节点及其实际引用。
 * @param changes 局部补丁。
 * @param definitions 当前工作区定义目录。
 */
function graphUpdateChanges(
  /* 当前 attempt 的只读图基线，结果另行复制，不原地修改。 */ document: GraphDocument,
  /* 与该图基线同次完整解析的节点及引用，修改时复制节点，不重新校验旧正文。 */ initialNodes: readonly ParsedGraphNode[],
  /* 已按公开白名单解析的节点和关系补丁。 */ changes: GraphChanges,
  /* 当前工作区的精确类型定义。 */ definitions: DefinitionCatalog,
  /* 授权事务确认的人工创建用户；内部无身份调用不补造来源。 */ actorUserId?: string,
): { document: GraphDocument; createdNodeIds: string[]; createdEdgeIds: string[]; writtenNodes: ParsedGraphNode[] } {
  // 在同一草稿中应用合法补丁，仅新建节点记人工来源，已有节点的创建信息原样保留。
  const now = new Date().toISOString()
  const nodePuts = changes.nodes?.put ?? [], nodeRemoves = graphReadUnique(changes.nodes?.remove ?? [], 'nodes.remove')
  const edgePuts = changes.edges?.put ?? [], edgeRemoves = graphReadUnique(changes.edges?.remove ?? [], 'edges.remove')
  graphReadUnique(nodePuts.map(item => item.id), 'nodes.put'); graphReadUnique(edgePuts.map(item => item.id), 'edges.put')
  if (nodePuts.some(item => nodeRemoves.has(item.id))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.A_NODE_CANNOT_BE_PUT_AND_REMOVED_TOGETHER)
  if (edgePuts.some(item => edgeRemoves.has(item.id))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.AN_EDGE_CANNOT_BE_PUT_AND_REMOVED_TOGETHER)
  if (changes.name === undefined && !nodePuts.length && !nodeRemoves.size && !edgePuts.length && !edgeRemoves.size) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.GRAPH_APPLY_CONTAINS_NO_CHANGES)
  const parsedNodes = new Map(initialNodes.map((/* 证明读取已经解析的节点状态。 */ parsed) =>
    /* 新图节点由本次修改独占；引用只读并始终随对应节点一起替换或移除。 */
    [parsed.node.id, { node: structuredClone(parsed.node), references: parsed.references }]))
  const edges = new Map(document.edges.map((/* 修改前的实际关系。 */ edge) =>
    /* 边草稿由本次修改独占，保持原文档不变。 */ [edge.id, structuredClone(edge)]))
  const retiredNodeIds = new Set(document.retiredNodeIds ?? []), retiredEdgeIds = new Set(document.retiredEdgeIds ?? [])
  for (const id of nodeRemoves) {
    if (!parsedNodes.delete(id)) throw new GraphError(404, 'NODE_NOT_FOUND', messageFormat(RuntimeMessage.NODE_NOT_FOUND_VALUE, id))
    retiredNodeIds.add(id)
    for (const [edgeId, edge] of edges) if (edge.from === id || edge.to === id) { edges.delete(edgeId); retiredEdgeIds.add(edgeId) }
  }
  const createdNodeIds: string[] = []
  const writtenNodes: ParsedGraphNode[] = []
  for (const input of nodePuts) {
    const existing = parsedNodes.get(input.id)?.node
    if (!existing && retiredNodeIds.has(input.id)) throw new GraphError(409, 'NODE_ID_REUSED', RuntimeMessage.DELETED_NODE_IDS_CANNOT_BE_REUSED)
    if (existing && (existing.typeId !== input.typeId || existing.typeVersion !== input.typeVersion)) throw new GraphError(422, 'NODE_TYPE_CHANGED', RuntimeMessage.NODE_TYPE_CHANGE_REQUIRES_AN_EXPLICIT_TRANSITION)
    const parsed = graphParseNodePayload(definitions, { id: input.typeId, version: input.typeVersion }, input.payload)
    const node: GraphNode = { ...existing, id: input.id, revision: existing ? existing.revision + 1 : 0, typeId: input.typeId,
      typeVersion: input.typeVersion, payload: parsed.payload,
      ...(!existing && actorUserId ? { manualOrigin: { userId: actorUserId } } : {}),
      ...(input.libraryClaimRefs === undefined ? {} : { libraryClaimRefs: graphInputReadLibraryUseRefs(input.libraryClaimRefs, `nodes.${input.id}.libraryClaimRefs`) }),
      payloadReferences: parsed.payloadReferences,
      createdAt: existing?.createdAt ?? now, updatedAt: now }
    const written = { node, references: parsed.references }
    parsedNodes.set(input.id, written)
    writtenNodes.push(written)
    if (!existing) createdNodeIds.push(input.id)
  }
  const nodes = new Map([...parsedNodes].map((/* 已验证正文与引用的节点状态。 */ [id, parsed]) =>
    /* 关系和闭包检查只需要实际图节点。 */ [id, parsed.node]))
  for (const id of edgeRemoves) {
    if (!edges.delete(id)) throw new GraphError(404, 'EDGE_NOT_FOUND', messageFormat(RuntimeMessage.EDGE_NOT_FOUND_VALUE, id))
    retiredEdgeIds.add(id)
  }
  const createdEdgeIds: string[] = []
  for (const input of edgePuts) {
    const from = nodes.get(input.from), to = nodes.get(input.to)
    if (!from || !to) throw new GraphError(422, 'INVALID_RELATION', RuntimeMessage.EDGE_REFERENCES_A_MISSING_NODE)
    if (input.from === input.to) throw new GraphError(422, 'INVALID_RELATION', messageFormat(RuntimeMessage.SELF_EDGE_IS_NOT_ALLOWED_VALUE, input.id))
    if (input.kind === 'successor') graphValidateSuccessor(definitions, from, to)
    const existing = edges.get(input.id)
    if (!existing && retiredEdgeIds.has(input.id)) throw new GraphError(409, 'EDGE_ID_REUSED', RuntimeMessage.DELETED_EDGE_IDS_CANNOT_BE_REUSED)
    const preservesAnchors = existing?.from === input.from && existing.kind === input.kind ? existing.sourceAnchors ?? [] : false
    graphValidateSourceAnchors(input, from, preservesAnchors)
    edges.set(input.id, { ...input, revision: existing ? existing.revision + 1 : 0, createdAt: existing?.createdAt ?? now, updatedAt: now })
    if (!existing) createdEdgeIds.push(input.id)
  }
  graphValidateNodeReferences(nodes, [...parsedNodes.values()].flatMap((/* 当前仍存在的一份已解析节点。 */ parsed) =>
    /* 与修改后的正文保持一一对应，不复用已删除或旧版本的引用。 */ parsed.references))
  graphValidateSuccessorAcyclic(nodes, edges)
  const { nodes: _previousNodes, edges: _previousEdges, ...metadata } = document
  return { document: { ...structuredClone(metadata), name: changes.name?.trim() || document.name, nodes: [...nodes.values()], edges: [...edges.values()],
    retiredNodeIds: [...retiredNodeIds].sort(), retiredEdgeIds: [...retiredEdgeIds].sort(), updatedAt: now }, createdNodeIds, createdEdgeIds, writtenNodes }
}

export interface GraphServiceOptions {
  clientLeases?: 'required' | 'none'
  leaseMs?: number
  branchLeaseMs?: number
  runControlLeaseMs?: number
  now?: () => Promise<number>
  readSource?: (workspaceId: string, node: GraphNode, path: string) => Promise<string>
  assertOutputReferences?: (
    /* 已由外层事务取得写栅栏的目标工作区。 */ workspaceId: string,
    /* 当前 attempt 完整解析、与正文配对的真实引用。 */ nodes: readonly ParsedGraphNode[],
  ) => Promise<void>
  // app必须把此服务和回调绑定同一事务；只在实际CAS成功后同步可回滚业务索引，失败会使外层事务回滚。
  onGraphCommit?: (
    /* 此次实际图写前的完整版本。 */ before: GraphDocument,
    /* 此次成功CAS后同事务可见的完整版本。 */ next: GraphDocument,
    /* 人工节点写入/删图，或使用Run冻结材料的执行变化。 */ mode: 'manual' | 'work',
  ) => Promise<void>
}
export interface GraphDispatchContext { definitions: DefinitionCatalog; run?: GraphRunStartContext; actorUserId?: string }

/**
 * 用户命令和 Work 复用同一图状态与最终裁决，队列只提供唤醒。
 *
 * @param store 图状态及最终写入条件。
 * @param options 租期和受限来源读取器。
 */
export function graphCreateService(store: GraphStore, options: GraphServiceOptions = {}) {
  const leaseMs = options.leaseMs ?? 15_000
  const branchLeaseMs = options.branchLeaseMs ?? 30_000
  const runControlLeaseMs = options.runControlLeaseMs ?? 30_000
  const readNow = options.now ?? (async () => Date.now())
  const clientLeasesRequired = options.clientLeases !== 'none'
  /**
   * @param document 当前图。
   * @param receipt 写入收据。
   * @param runControl 协作模式启动时授予的控制权。
   */
  function graphWriteResult(document: GraphDocument, receipt: GraphReceipt,
    runControl?: GraphRunControlGrant): GraphWriteResult {
    return graphCreateWriteResult(document, receipt, runControl, clientLeasesRequired)
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000) throw new Error(RuntimeMessage.LEASEMS_MUST_BE_BETWEEN_100_AND_300000)
  if (!Number.isSafeInteger(branchLeaseMs) || branchLeaseMs < 1_000 || branchLeaseMs > 300_000) throw new Error(RuntimeMessage.BRANCH_LEASEMS_MUST_BE_BETWEEN_1000_AND_300000)
  if (!Number.isSafeInteger(runControlLeaseMs) || runControlLeaseMs < 1_000 || runControlLeaseMs > 300_000) throw new Error(RuntimeMessage.RUN_CONTROL_LEASEMS_MUST_BE_BETWEEN_1000_AND_300000)
  /**
   * @param mapId 未删除图身份。
   */
  async function graphReadMap(
    /* 本次图查询或写入指定的稳定身份。 */ mapId: string,
    /* 仅原删除命令允许读取墓碑以核对同参收据，默认拒绝已删除图。 */ allowDeleted = false,
  ): Promise<GraphDocument> {
    // 读取图并按本机协调策略过滤旧客户端占有，删除重放可保留墓碑到收据核对之后。
    const document = await store.read(mapId)
    if (!document || document.deletedAt && !allowDeleted) throw new GraphError(404, 'MAP_NOT_FOUND', messageFormat(RuntimeMessage.MAP_NOT_FOUND_VALUE, mapId))
    if (!clientLeasesRequired) document.branchOwnerships = Object.fromEntries(
      Object.entries(document.branchOwnerships ?? {}).filter(([, item]) => item.kind === 'run'))
    return document
  }
  /**
   * CAS 未命中后先查收据，区分响应丢失和真实竞争。
   *
   * @param original 原状态。
   * @param updated 业务草稿。
   * @param receipt 同次收据。
   * @param grant 可选最终 Work 授权。
   * @param guard 最终分支占有条件。
   */
  async function graphCommit(
    /* 计算本次业务草稿时实际读取的持久化图。 */ original: GraphDocument,
    /* 保留原内容版本、等待最终 CAS 的新图草稿。 */ updated: GraphDocument,
    /* 与图变更同次提交的原请求幂等收据。 */ receipt: GraphReceipt,
    /* 执行提交需要的可选工作授权，人工操作省略。 */ grant?: GraphWorkGrant,
    /* 最终占有守卫，省略时仍必须匹配原协调版本。 */ guard?: GraphCommitGuard,
  ): Promise<{ document: GraphDocument; receipt: GraphReceipt; replayed: boolean }> {
    // 原子提交图与收据，仅成功后调用同事务钩子；失败先核对原收据以确认响应丢失。
    if (await store.commit(updated, original.revision, receipt, grant, guard ?? { ownershipRevision: original.ownershipRevision ?? 0 })) {
      const committed = await store.read(updated.id)
      if (!committed) throw new Error(messageFormat(RuntimeMessage.COMMITTED_MAP_DISAPPEARED_VALUE, updated.id))
      const mode = receipt.method === 'graph.apply' || receipt.method === 'map.rename' || receipt.method === 'map.delete' ? 'manual' : 'work'
      await options.onGraphCommit?.(original, committed, mode)
      return { document: committed, receipt, replayed: false }
    }
    const latest = await store.read(updated.id)
    if (!latest) throw new GraphError(404, 'MAP_NOT_FOUND', messageFormat(RuntimeMessage.MAP_NOT_FOUND_VALUE, updated.id))
    const replay = graphReadReceipt(latest, receipt.requestId, receipt.method, receipt.inputHash)
    if (replay) return { document: latest, receipt: replay, replayed: true }
    throw new GraphError(409, 'REVISION_CONFLICT', messageFormat(RuntimeMessage.MAP_REVISION_CHANGED_VALUE, updated.id), latest.revision)
  }

  async function graphRenameMap(
    /* 已读取且尚未删除的图，收据已在外层优先核对。 */ document: GraphDocument,
    /* 已授权的元数据命令，名称和预期内容版本属于同一原请求。 */ command: Extract<GraphCommand, { method: 'map.rename' }>,
    /* 包含方法和完整参数的稳定摘要，不能在重试时更改。 */ inputHash: string,
    /* 本次接受命令的服务端时间文本。 */ now: string,
  ): Promise<{ data: GraphWriteResult; replayed: boolean }> {
    // 只在图无人编辑且无活动运行时改名，将新名称和原请求收据原子提交。
    const name = command.params.name.trim()
    if (!name || name.length > 120) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.MAP_RENAME_NAME_MUST_BE_BETWEEN_1_AND_120)
    if (document.runs.some((/* 图中一个当前运行记录。 */ run) => /* 运行或等待中的 Run 阻止全图元数据变更。 */ ['running', 'waiting'].includes(run.status))) {
      throw new GraphError(409, 'RUN_ACTIVE', RuntimeMessage.MAP_RENAME_REQUIRES_NO_ACTIVE_RUN)
    }
    if (branchReadOwnerships(document, await readNow()).length) throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.MAP_RENAME_REQUIRES_RELEASED_BRANCHES)
    if (document.revision !== command.params.expectedRevision) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.MAP_REVISION_CHANGED, document.revision)
    const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now)
    const result = await graphCommit(document, { ...document, name, updatedAt: now }, receipt)
    return { data: graphWriteResult(result.document, result.receipt), replayed: result.replayed }
  }

  /**
   * @param document 当前图。
   * @param actorUserId 用户身份。
   * @param requestId 请求身份。
   * @param method 方法。
   * @param inputHash 输入摘要。
   */
  function graphReadOwnershipReceipt(document: GraphDocument, actorUserId: string,
    requestId: string, method: GraphOwnershipReceipt['method'], inputHash: string): GraphOwnershipReceipt | null {
    const receipt = (document.ownershipReceipts ?? []).find(item => item.actorUserId === actorUserId && item.requestId === requestId)
    if (!receipt) return null
    if (receipt.method !== method || receipt.inputHash !== inputHash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_WAS_ALREADY_USED_WITH_DIFFERENT_INPUT)
    return receipt
  }

  /**
   * @param document 当前图。
   * @param actorUserId 用户身份。
   * @param proof 客户端租约 proof。
   * @param now 存储端当前时间。
   */
  function graphReadEditorOwnership(
    /* 当前图内容及保存的客户端占有记录。 */ document: GraphDocument,
    /* 本次已认证编辑者身份。 */ actorUserId: string,
    /* 客户端声明的编辑租约身份与栅栏。 */ proof: GraphBranchLeaseProof,
    /* 判断编辑租约是否过期的存储时钟。 */ now: number,
  ): GraphEditorOwnershipRecord {
    // 同时核对编辑种类、身份、栅栏和期限，返回已缩窄的有效编辑占有。
    const ownership = document.branchOwnerships?.[proof.leaseId]
    if (!ownership || ownership.kind !== 'editor' || ownership.ownerUserId !== actorUserId || ownership.holderId !== proof.holderId
      || ownership.fence !== proof.fence || ownership.expiresAt === null || Date.parse(ownership.expiresAt) <= now) {
      throw new GraphError(409, 'BRANCH_LEASE_LOST', RuntimeMessage.BRANCH_EDIT_LEASE_WAS_LOST)
    }
    return ownership
  }

  /**
   * @param left 一侧根集合。
   * @param right 另一侧根集合。
   */
  function graphSameRoots(
    /* 一侧已验证的根身份集合，不修改输入顺序。 */ left: readonly string[],
    /* 待比较的另一侧已验证根集合。 */ right: readonly string[],
  ): boolean {
    // 各排序一次后比较授权范围，避免每个成员都重新排序整组根。
    if (left.length !== right.length) return false
    const sortedLeft = [...left].sort()
    const sortedRight = [...right].sort()
    return sortedLeft.every((/* 一侧排序后的根身份。 */ id, /* 与另一侧对应的位置。 */ index) =>
      /* 根集合与输入原顺序无关。 */ id === sortedRight[index])
  }

  /**
   * @param document 已提交占有后的图状态。
   * @param ownership editor 占有。
   */
  function graphReadBranchGrant(
    /* 占有变更已经同次提交的当前图。 */ document: GraphDocument,
    /* 已核对身份、种类与有效期的编辑占有。 */ ownership: GraphEditorOwnershipRecord,
  ): GraphBranchGrant {
    // 把真实分支证明附到编辑占有上，字段类型直接沿用已确定的 editor 状态。
    const branch = branchReadSnapshot(document, ownership.rootIds)
    return { ...structuredClone(ownership),
      scope: branch.scope, branch, ownershipRevision: document.ownershipRevision ?? 0 }
  }
  /**
   * @param document 当前图。
   * @param actorUserId 用户身份。
   * @param runId Run 身份。
   * @param proof 客户端控制 proof。
   * @param now 存储端当前时间。
   */
  function graphReadRunControl(document: GraphDocument, actorUserId: string, runId: string,
    proof: GraphRunControlProof, now: number): GraphRunControlRecord {
    if (!proof) throw new GraphError(409, 'RUN_CONTROL_LEASE_REQUIRED', RuntimeMessage.A_VALID_RUN_CONTROL_LEASE_IS_REQUIRED)
    const control = document.branchOwnerships?.[proof.leaseId]
    if (!control || control.kind !== 'control' || control.runId !== runId || control.ownerUserId !== actorUserId
      || control.holderId !== proof.holderId || control.fence !== proof.fence || Date.parse(control.expiresAt) <= now) {
      throw new GraphError(409, 'RUN_CONTROL_LEASE_LOST', RuntimeMessage.RUN_CONTROL_LEASE_WAS_LOST)
    }
    return control
  }
  /**
   * @param document 已提交协调状态。
   * @param control 控制租约。
   */
  function graphReadRunControlGrant(document: GraphDocument, control: GraphRunControlRecord): GraphRunControlGrant {
    const { kind: _kind, ...grant } = structuredClone(control)
    return { ...grant, ownershipRevision: document.ownershipRevision ?? 0 }
  }
  /**
   * @param document 待提交文档。
   * @param runId 终态 Run。
   */
  function graphReleaseRunOwnerships(document: GraphDocument, runId: string): boolean {
    let changed = false
    for (const [id, ownership] of Object.entries(document.branchOwnerships ?? {})) {
      if ((ownership.kind === 'run' || ownership.kind === 'control') && ownership.runId === runId) {
        delete document.branchOwnerships![id]; changed = true
      }
    }
    return changed
  }
  /**
   * @param document 当前图。
   * @param runId Work 所属 Run。
   */
  function graphRequireRunOwnership(document: GraphDocument, runId: string): void {
    const ownership = document.branchOwnerships?.[runId]
    if (!ownership || ownership.kind !== 'run' || ownership.runId !== runId) {
      throw new GraphError(409, 'RUN_OWNERSHIP_LOST', RuntimeMessage.RUN_BRANCH_OWNERSHIP_IS_MISSING)
    }
  }

  /**
   * @param command 已解析的领取、续租或释放命令。
   * @param actorUserId 由认证事务绑定的用户身份。
   * @param inputHash 稳定输入摘要。
   */
  async function graphDispatchOwnership(
    command: Extract<GraphCommand, { method: 'branch.claim' | 'branch.renew' | 'branch.release' }>,
    actorUserId: string,
    inputHash: string,
  ): Promise<{ data: GraphBranchClaimResult | GraphBranchGrant | { released: boolean; ownershipRevision: number }; replayed: boolean }> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const document = await graphReadMap(command.params.mapId), replay = graphReadOwnershipReceipt(document, actorUserId,
        command.requestId, command.method, inputHash)
      if (replay) return { data: structuredClone(replay.result) as GraphBranchClaimResult | GraphBranchGrant | { released: boolean; ownershipRevision: number }, replayed: true }
      const now = await readNow(), ownerships = branchPruneOwnerships(document.branchOwnerships, now)
      let result: GraphBranchClaimResult | GraphBranchGrant | { released: boolean; ownershipRevision: number }
      let leaseId: string
      if (command.method === 'branch.claim') {
        const branch = branchReadSnapshot(document, command.params.rootIds)
        const existing = Object.values(ownerships).find((item): item is GraphEditorOwnershipRecord => item.kind === 'editor' && item.ownerUserId === actorUserId
          && item.holderId === command.params.holderId && JSON.stringify([...item.rootIds].sort()) === JSON.stringify([...branch.scope.rootIds].sort()))
        const conflict = branchFindOwnershipConflict({ ...document, branchOwnerships: ownerships }, branch.scope, now, existing?.leaseId)
        if (conflict) return { data: { status: 'busy', ownership: conflict }, replayed: false }
        leaseId = existing?.leaseId ?? randomUUID()
        const editor: GraphEditorOwnershipRecord = existing ?? { leaseId, kind: 'editor', rootIds: [...branch.scope.rootIds], ownerUserId: actorUserId,
          holderId: command.params.holderId, fence: (document.ownershipRevision ?? 0) + 1,
          expiresAt: new Date(now + branchLeaseMs).toISOString(), leaseMs: branchLeaseMs }
        editor.expiresAt = new Date(now + branchLeaseMs).toISOString()
        ownerships[leaseId] = editor
        const nextDocument = { ...document, branchOwnerships: ownerships, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }
        result = { status: 'claimed', grant: graphReadBranchGrant(nextDocument, editor) }
      } else if (command.method === 'branch.renew') {
        const ownership = graphReadEditorOwnership({ ...document, branchOwnerships: ownerships }, actorUserId, command.params.lease, now)
        leaseId = ownership.leaseId
        ownership.expiresAt = new Date(now + ownership.leaseMs).toISOString()
        const nextDocument = { ...document, branchOwnerships: ownerships, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }
        result = graphReadBranchGrant(nextDocument, ownership)
      } else {
        const ownership = graphReadEditorOwnership({ ...document, branchOwnerships: ownerships }, actorUserId, command.params.lease, now)
        leaseId = ownership.leaseId
        delete ownerships[leaseId]
        result = { released: true, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }
      }
      const receipt: GraphOwnershipReceipt = { actorUserId, requestId: command.requestId, method: command.method, inputHash,
        leaseId, result: structuredClone(result), createdAt: new Date(now).toISOString() }
      if (await store.commitOwnership(document.id, document.revision, document.ownershipRevision ?? 0, ownerships, receipt)) {
        return { data: result, replayed: false }
      }
    }
    throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_BRANCH_OWNERSHIP_AFTER_CONCURRENT_UPDATES_SETTLE)
  }

  /**
   * @param command 控制权领取、续租或释放。
   * @param actorUserId 认证用户。
   * @param inputHash 稳定输入摘要。
   */
  async function graphDispatchRunControl(
    command: Extract<GraphCommand, { method: 'run.control.claim' | 'run.control.renew' | 'run.control.release' }>,
    actorUserId: string, inputHash: string,
  ): Promise<{ data: GraphRunControlClaimResult | GraphRunControlGrant | { released: boolean; ownershipRevision: number }; replayed: boolean }> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const document = await graphReadMap(command.params.mapId), replay = graphReadOwnershipReceipt(document, actorUserId,
        command.requestId, command.method, inputHash)
      if (replay) return { data: structuredClone(replay.result) as GraphRunControlClaimResult | GraphRunControlGrant | { released: boolean; ownershipRevision: number }, replayed: true }
      const run = document.runs.find(item => item.id === command.params.runId)
      if (!run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.RUN_NOT_FOUND)
      if (!['running', 'waiting'].includes(run.status)) throw new GraphError(409, 'RUN_NOT_ACTIVE', RuntimeMessage.RUN_IS_TERMINAL)
      const now = await readNow(), ownerships = branchPruneOwnerships(document.branchOwnerships, now)
      let result: GraphRunControlClaimResult | GraphRunControlGrant | { released: boolean; ownershipRevision: number }
      let leaseId: string
      if (command.method === 'run.control.claim') {
        const current = Object.values(ownerships).find((item): item is GraphRunControlRecord => item.kind === 'control' && item.runId === run.id)
        if (current && (current.ownerUserId !== actorUserId || current.holderId !== command.params.holderId)) {
          const { kind: _kind, ...control } = structuredClone(current)
          return { data: { status: 'busy', control }, replayed: false }
        }
        leaseId = current?.leaseId ?? randomUUID()
        const control: GraphRunControlRecord = current ?? { leaseId, kind: 'control', runId: run.id, ownerUserId: actorUserId,
          holderId: command.params.holderId, fence: (document.ownershipRevision ?? 0) + 1,
          expiresAt: new Date(now + runControlLeaseMs).toISOString(), leaseMs: runControlLeaseMs }
        control.expiresAt = new Date(now + runControlLeaseMs).toISOString()
        ownerships[leaseId] = control
        result = { status: 'claimed', grant: graphReadRunControlGrant({ ...document,
          ownershipRevision: (document.ownershipRevision ?? 0) + 1 }, control) }
      } else if (command.method === 'run.control.renew') {
        const control = graphReadRunControl({ ...document, branchOwnerships: ownerships }, actorUserId, run.id, command.params.control, now)
        leaseId = control.leaseId
        control.expiresAt = new Date(now + control.leaseMs).toISOString()
        result = graphReadRunControlGrant({ ...document, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }, control)
      } else {
        const control = graphReadRunControl({ ...document, branchOwnerships: ownerships }, actorUserId, run.id, command.params.control, now)
        leaseId = control.leaseId
        delete ownerships[leaseId]
        result = { released: true, ownershipRevision: (document.ownershipRevision ?? 0) + 1 }
      }
      const receipt: GraphOwnershipReceipt = { actorUserId, requestId: command.requestId, method: command.method, inputHash,
        leaseId, result: structuredClone(result), createdAt: new Date(now).toISOString() }
      if (await store.commitOwnership(document.id, document.revision, document.ownershipRevision ?? 0, ownerships, receipt)) {
        return { data: result, replayed: false }
      }
    }
    throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_BRANCH_OWNERSHIP_AFTER_CONCURRENT_UPDATES_SETTLE)
  }

  return {
    /**
     * @param query 已授权图查询。
     * @param definitions branch.get 可用的当前工作区定义，用于兼容重建派生引用索引。
     */
    async read(
      /* 已由应用按 Map viewer 权限授权的公开查询。 */ query: GraphQuery,
      /* branch.get 重建派生引用索引时使用的当前工作区目录。 */ definitions?: DefinitionCatalog,
    ): Promise<GraphSnapshot | GraphMapSummary[] | GraphRun | GraphBranchSnapshot | GraphPublicationPreview | GraphRunPage> {
      // 在当前存储快照中读取目标；目录与发布预览只做领域计算，不提交图或取得控制租约。
      if (query.method === 'map.list') return store.list(query.params.workspaceId)
      const stored = await graphReadMap(query.params.mapId)
      const document = query.method === 'branch.get' && definitions
        ? { ...stored, nodes: graphParseNodes(definitions, stored.nodes).map((/* 已解析的节点与引用状态。 */ parsed) =>
          /* 分支查询只投影含权威引用索引的实际节点。 */ parsed.node) } : stored
      if (query.method === 'branch.get') return branchReadSnapshot(document, query.params.rootIds)
      if (query.method === 'run.list') return graphReadRunPage(document, query.params)
      if (query.method === 'run.publication.preview') return runReadPublicationPreview(document, query.params)
      if (query.method === 'run.get') {
        const run = document.runs.find(item => item.id === query.params.runId) ?? document.runHistory.find(item => item.id === query.params.runId)
        if (!run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.RUN_NOT_FOUND)
        return structuredClone(run)
      }
      return graphReadSnapshot(document, await readNow(), clientLeasesRequired)
    },

    /**
     * @param command 用户级幂等图命令。
     * @param context 定义及可选冻结 Run 上下文。
     */
    async dispatch(
      /* 已由应用鉴权并按用户隔离请求编号的完整图命令。 */ command: GraphCommand,
      /* 分支写入所需的定义与用户；纯图元数据动作无需额外目录。 */ context?: GraphDispatchContext,
    ): Promise<{
      data: GraphWriteResult | { mapId: string; deleted: true } | GraphBranchClaimResult | GraphBranchGrant | GraphRunControlClaimResult | GraphRunControlGrant
        | { released: boolean; ownershipRevision: number }; replayed: boolean
    }> {
      // 先核对原请求收据，再检查新动作的版本、占有和业务条件并原子提交。
      const inputHash = storeCreateInputHash({ method: command.method, params: command.params }), now = new Date().toISOString()
      if (command.method === 'map.create') {
        const prior = await store.read(command.params.id)
        if (prior) {
          const replay = graphReadReceipt(prior, command.requestId, command.method, inputHash)
          if (!replay || prior.deletedAt) throw new GraphError(409, 'MAP_EXISTS', messageFormat(RuntimeMessage.MAP_ALREADY_EXISTS_VALUE, prior.id))
          return { data: graphWriteResult(prior, replay), replayed: true }
        }
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now)
        const document: GraphDocument = { id: command.params.id, workspaceId: command.params.workspaceId, revision: 0, name: command.params.name.trim(),
          nodes: [], edges: [], retiredNodeIds: [], retiredEdgeIds: [], ownershipRevision: 0, branchOwnerships: {}, ownershipReceipts: [],
          runs: [], runHistory: [], leases: {}, receipts: [receipt], createdAt: now, updatedAt: now }
        if (!document.name) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.MAP_NAME_MUST_NOT_BE_EMPTY)
        if (await store.create(document)) return { data: graphWriteResult(document, receipt), replayed: false }
        const existing = await store.read(document.id)
        if (!existing) throw new Error(messageFormat(RuntimeMessage.DUPLICATE_MAP_DISAPPEARED_VALUE, document.id))
        const replay = graphReadReceipt(existing, command.requestId, command.method, inputHash)
        if (!replay || existing.deletedAt) throw new GraphError(409, 'MAP_EXISTS', messageFormat(RuntimeMessage.MAP_ALREADY_EXISTS_VALUE, document.id))
        return { data: graphWriteResult(existing, replay), replayed: true }
      }
      if (command.method === 'branch.claim' || command.method === 'branch.renew' || command.method === 'branch.release') {
        if (!clientLeasesRequired) throw new GraphError(409, 'CLIENT_LEASES_DISABLED', RuntimeMessage.LOCAL_MODE_DOES_NOT_USE_CLIENT_LEASES)
        if (!context?.actorUserId) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
        return graphDispatchOwnership(command, context.actorUserId, inputHash)
      }
      if (command.method === 'run.control.claim' || command.method === 'run.control.renew' || command.method === 'run.control.release') {
        if (!clientLeasesRequired) throw new GraphError(409, 'CLIENT_LEASES_DISABLED', RuntimeMessage.LOCAL_MODE_DOES_NOT_USE_CLIENT_LEASES)
        if (!context?.actorUserId) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
        return graphDispatchRunControl(command, context.actorUserId, inputHash)
      }
      const document = await graphReadMap(command.params.mapId, command.method === 'map.delete')
      const prior = graphReadReceipt(document, command.requestId, command.method, inputHash)
      if (prior) return command.method === 'map.delete' ? { data: { mapId: document.id, deleted: true }, replayed: true }
        : { data: graphWriteResult(document, prior), replayed: true }
      if (document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', messageFormat(RuntimeMessage.MAP_NOT_FOUND_VALUE, document.id))
      if (command.method === 'map.rename') return graphRenameMap(document, command, inputHash, now)
      if (command.method === 'map.delete') {
        if (document.runs.some(run => ['running', 'waiting'].includes(run.status))) throw new GraphError(409, 'RUN_ACTIVE', RuntimeMessage.ACTIVE_RUN_MUST_BE_CANCELLED_BEFORE_DELETING_MAP)
        if (branchReadOwnerships(document, await readNow()).length) throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.RELEASE_ACTIVE_BRANCHES_BEFORE_DELETING_MAP)
        if (document.revision !== command.params.expectedRevision) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.MAP_REVISION_CHANGED, document.revision)
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now)
        const result = await graphCommit(document, { ...document, deletedAt: now, updatedAt: now }, receipt)
        return { data: { mapId: result.document.id, deleted: true }, replayed: result.replayed }
      }
      if (!context) throw new GraphError(409, 'DEFINITION_NOT_FOUND', RuntimeMessage.GRAPH_WRITE_REQUIRES_A_DEFINITION_CATALOG)
      if (command.method === 'graph.apply') {
        // Map revision 只负责物理串行化；无关分支抢先提交时从最新图重放同一局部补丁。
        for (let attempt = 0; attempt < 64; attempt++) {
          const stored = attempt === 0 ? document : await graphReadMap(command.params.mapId)
          const initialNodes = graphParseNodes(context.definitions, stored.nodes)
          const current = { ...stored, nodes: initialNodes.map((/* 当前 attempt 的完整解析结果。 */ parsed) =>
            /* 证明和后续修改共用同一份正文及其权威索引。 */ parsed.node) }
          const replay = graphReadReceipt(current, command.requestId, command.method, inputHash)
          if (replay) return { data: graphWriteResult(current, replay), replayed: true }
          const proof = command.params.branch
          const before = proof.expectedVersion === null ? undefined : branchReadSnapshot(current, proof.rootIds)
          if (before && before.version !== proof.expectedVersion) {
            throw new GraphError(409, 'BRANCH_VERSION_CONFLICT', RuntimeMessage.BRANCH_VERSION_CHANGED)
          }
          const nowMs = await readNow(), activeOwnerships = branchPruneOwnerships(current.branchOwnerships, nowMs)
          let editor: GraphEditorOwnershipRecord | undefined
          if (before && clientLeasesRequired) {
            if (!context.actorUserId || !command.params.lease) throw new GraphError(409, 'BRANCH_LEASE_REQUIRED', RuntimeMessage.A_VALID_BRANCH_EDIT_LEASE_IS_REQUIRED)
            editor = graphReadEditorOwnership({ ...current, branchOwnerships: activeOwnerships }, context.actorUserId, command.params.lease, nowMs)
            if (!graphSameRoots(editor.rootIds, proof.rootIds)) throw new GraphError(409, 'BRANCH_LEASE_SCOPE_CONFLICT', RuntimeMessage.BRANCH_EDIT_LEASE_DOES_NOT_COVER_THE_REQUESTED_ROOTS)
          }
          // 删除整个根也必须先检查旧 scope，不能因修改后没有分支而绕过运行占有。
          if (before && branchFindOwnershipConflict({ ...current, branchOwnerships: activeOwnerships }, before.scope, nowMs, editor?.leaseId)) {
            throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
          }
          const change = graphUpdateChanges(current, initialNodes, command.params.changes, context.definitions, context.actorUserId)
          const branch = proof.expectedVersion === null
            ? branchValidateNewRoots(current, change.document, proof.rootIds, command.params.changes)
            : branchValidateMutation(current, change.document, command.params.changes, before!.scope)
          if (branch) {
            const conflict = branchFindOwnershipConflict({ ...change.document, branchOwnerships: activeOwnerships }, branch.scope, nowMs, editor?.leaseId)
            if (conflict) throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
          }
          change.document.branchOwnerships = activeOwnerships
          change.document.ownershipReceipts = current.ownershipReceipts ?? []
          change.document.ownershipRevision = current.ownershipRevision ?? 0
          if (editor && !branch) {
            delete activeOwnerships[editor.leaseId]
            change.document.ownershipRevision++
          } else if (editor && branch && before && JSON.stringify(before.scope.nodeIds) !== JSON.stringify(branch.scope.nodeIds)) {
            change.document.ownershipRevision++
          }
          if (options.assertOutputReferences && change.writtenNodes.length) {
            await options.assertOutputReferences(current.workspaceId, change.writtenNodes)
          }
          const committedBranch = branch ? { ...branch, mapRevision: current.revision + 1 } : undefined
          const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now,
            change.createdNodeIds, change.createdEdgeIds, committedBranch)
          try {
            const guard: GraphCommitGuard = { ownershipRevision: current.ownershipRevision ?? 0,
              ...(editor && command.params.lease && context.actorUserId ? { editor: { ...command.params.lease, ownerUserId: context.actorUserId } } : {}) }
            const result = await graphCommit(current, change.document, receipt, undefined, guard)
            return { data: graphWriteResult(result.document, result.receipt), replayed: result.replayed }
          } catch (error) {
            if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error
          }
        }
        throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_GRAPH_CHANGE_AFTER_CONCURRENT_UPDATES_SETTLE)
      }
      if (command.method === 'run.start') {
        if (!context.run) throw new GraphError(409, 'DEFINITION_NOT_FOUND', RuntimeMessage.RUN_START_REQUIRES_A_FROZEN_EXECUTION_CATALOG)
        for (let attempt = 0; attempt < 64; attempt++) {
          const stored = attempt === 0 ? document : await graphReadMap(command.params.mapId)
          const current = { ...stored, nodes: graphParseNodes(context.definitions, stored.nodes).map((/* 当前读取的已解析节点状态。 */ parsed) =>
            /* Run 启动沿当前权威引用索引计算分支。 */ parsed.node) }
          const replay = graphReadReceipt(current, command.requestId, command.method, inputHash)
          if (replay) return { data: graphWriteResult(current, replay), replayed: true }
          const branch = branchReadSnapshot(current, command.params.branch.rootIds)
          if (branch.version !== command.params.branch.expectedVersion) {
            throw new GraphError(409, 'BRANCH_VERSION_CONFLICT', RuntimeMessage.BRANCH_VERSION_CHANGED)
          }
          const members = new Set(branch.scope.nodeIds)
          if (command.params.scope.nodeIds.some(id => !members.has(id))) {
            throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.RUN_SCOPE_MUST_BE_INSIDE_THE_VERSIONED_BRANCH)
          }
          if (!context.actorUserId) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
          const nowMs = await readNow(), activeOwnerships = branchPruneOwnerships(current.branchOwnerships, nowMs)
          let editor: GraphEditorOwnershipRecord | undefined
          if (clientLeasesRequired) {
            if (!command.params.lease) throw new GraphError(409, 'BRANCH_LEASE_REQUIRED', RuntimeMessage.A_VALID_BRANCH_EDIT_LEASE_IS_REQUIRED)
            editor = graphReadEditorOwnership({ ...current, branchOwnerships: activeOwnerships }, context.actorUserId, command.params.lease, nowMs)
            if (!graphSameRoots(editor.rootIds, command.params.branch.rootIds)) throw new GraphError(409, 'BRANCH_LEASE_SCOPE_CONFLICT', RuntimeMessage.BRANCH_EDIT_LEASE_DOES_NOT_COVER_THE_REQUESTED_ROOTS)
          }
          if (branchFindOwnershipConflict({ ...current, branchOwnerships: activeOwnerships }, branch.scope, nowMs, editor?.leaseId)) {
            throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
          }
          const updated = runCreateRun(structuredClone(current), command.params, context.run, now)
          const startedRun = runReadRun(updated, command.params.id)
          if (editor) delete activeOwnerships[editor.leaseId]
          let controlLeaseId: string | undefined
          if (['running', 'waiting'].includes(startedRun.status)) {
            activeOwnerships[startedRun.id] = { leaseId: startedRun.id, kind: 'run', rootIds: [...branch.scope.rootIds],
              ownerUserId: context.actorUserId, holderId: editor?.holderId ?? context.actorUserId, fence: (current.ownershipRevision ?? 0) + 1,
              expiresAt: null, leaseMs: null, runId: startedRun.id }
            if (editor) {
              controlLeaseId = randomUUID()
              activeOwnerships[controlLeaseId] = { leaseId: controlLeaseId, kind: 'control', runId: startedRun.id,
                ownerUserId: context.actorUserId, holderId: editor.holderId, fence: (current.ownershipRevision ?? 0) + 1,
                expiresAt: new Date(nowMs + runControlLeaseMs).toISOString(), leaseMs: runControlLeaseMs }
            }
          }
          updated.branchOwnerships = activeOwnerships
          updated.ownershipReceipts = current.ownershipReceipts ?? []
          updated.ownershipRevision = (current.ownershipRevision ?? 0) + 1
          const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now, [], [], { ...branch, mapRevision: current.revision + 1 })
          try {
            const result = await graphCommit(current, updated, receipt, undefined, { ownershipRevision: current.ownershipRevision ?? 0,
              ...(editor ? { editor: { leaseId: editor.leaseId, holderId: editor.holderId, fence: editor.fence, ownerUserId: context.actorUserId } } : {}) })
            const control = controlLeaseId ? result.document.branchOwnerships?.[controlLeaseId] : undefined
            return { data: graphWriteResult(result.document, result.receipt,
              control?.kind === 'control' ? graphReadRunControlGrant(result.document, control) : undefined), replayed: result.replayed }
          } catch (error) {
            if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error
          }
        }
        throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_GRAPH_CHANGE_AFTER_CONCURRENT_UPDATES_SETTLE)
      }
      if (!context.actorUserId) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
      for (let attempt = 0; attempt < 64; attempt++) {
        const current = attempt === 0 ? document : await graphReadMap(command.params.mapId)
        const replay = graphReadReceipt(current, command.requestId, command.method, inputHash)
        if (replay) return { data: graphWriteResult(current, replay), replayed: true }
        const controlNow = await readNow(), activeOwnerships = branchPruneOwnerships(current.branchOwnerships, controlNow)
        if (clientLeasesRequired && !command.params.control) throw new GraphError(409, 'RUN_CONTROL_LEASE_REQUIRED', RuntimeMessage.A_VALID_RUN_CONTROL_LEASE_IS_REQUIRED)
        const control = clientLeasesRequired ? graphReadRunControl({ ...current, branchOwnerships: activeOwnerships }, context.actorUserId,
          command.params.runId, command.params.control!, controlNow) : undefined
        let updated: GraphDocument, createdNodeIds: string[] = [], createdEdgeIds: string[] = [], publishedNodes: ParsedGraphNode[] = []
        if (command.method === 'run.cancel') updated = runCancelRun(structuredClone(current), command.params.runId, now)
        else if (command.method === 'run.pause') updated = runUpdatePause(structuredClone(current), command.params.runId, true, now)
        else if (command.method === 'run.resume') updated = runUpdatePause(structuredClone(current), command.params.runId, false, now)
        else if (command.method === 'review.answer') {
          const answer = runAnswerReview(structuredClone(current), command.params, now)
          updated = answer.document; createdNodeIds = answer.nodeIds; createdEdgeIds = answer.edgeIds; publishedNodes = answer.publishedNodes
        } else throw new GraphError(400, 'UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_COMMAND)
        const runId = command.params.runId, runOwnership = current.branchOwnerships?.[runId]
        if (!runOwnership || runOwnership.kind !== 'run' || runOwnership.runId !== runId) {
          throw new GraphError(409, 'RUN_OWNERSHIP_LOST', RuntimeMessage.RUN_BRANCH_OWNERSHIP_IS_MISSING)
        }
        updated.branchOwnerships = activeOwnerships
        updated.ownershipReceipts = structuredClone(current.ownershipReceipts ?? [])
        updated.ownershipRevision = current.ownershipRevision ?? 0
        const targetRun = runReadRun(updated, runId)
        if (['completed', 'failed', 'cancelled'].includes(targetRun.status)) {
          if (graphReleaseRunOwnerships(updated, runId)) updated.ownershipRevision++
        } else if (targetRun.branchState) {
          const conflict = branchFindOwnershipConflict(updated, targetRun.branchState.scope, controlNow, runId)
          if (conflict) throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
        }
        if (options.assertOutputReferences && publishedNodes.length) {
          await options.assertOutputReferences(current.workspaceId, publishedNodes)
        }
        const receipt = graphCreateReceipt(command.requestId, command.method, inputHash, now, createdNodeIds, createdEdgeIds)
        try {
          const result = await graphCommit(current, updated, receipt, undefined, { ownershipRevision: current.ownershipRevision ?? 0, runId,
            ...(control ? { control: { leaseId: control.leaseId, holderId: control.holderId, fence: control.fence, ownerUserId: context.actorUserId, runId } } : {}) })
          return { data: graphWriteResult(result.document, result.receipt), replayed: result.replayed }
        } catch (error) { if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_GRAPH_CHANGE_AFTER_CONCURRENT_UPDATES_SETTLE)
    },

    /**
     * @param command 内部 Host 工作命令。
     */
    async dispatchWork(command: GraphWorkCommand) {
      if (command.method === 'claim') {
        const input = command.params
        for (let attempt = 0; attempt < 64; attempt++) {
          const document = await store.read(input.mapId)
          if (!document || document.deletedAt) return { status: 'obsolete' } satisfies GraphClaimResult
          const work = workReadItems(document).find(item => item.workId === input.workId)
          if (!work || !document.branchOwnerships?.[work.runId] || document.receipts.some(receipt => receipt.requestId === input.workId)) return { status: 'obsolete' } satisfies GraphClaimResult
          const prior = document.leases[input.workId]
          if (prior && prior.holderId === input.holderId && prior.hostId === input.hostId) {
            const current = await store.readLease(document.id, prior)
            if (current) return { status: 'claimed', grant: current.leases[input.workId] } satisfies GraphClaimResult
          }
          const grant = await store.claim(document, work, input.hostId, input.holderId, leaseMs)
          if (grant) return { status: 'claimed', grant } satisfies GraphClaimResult
          const retryAfterMs = await store.readLeaseDelay(input.mapId, input.workId)
          if (retryAfterMs > 0) return { status: 'busy', retryAfterMs } satisfies GraphClaimResult
        }
        throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_CLAIM_AFTER_CONCURRENT_UPDATES_SETTLE)
      }
      if (command.method === 'renew') {
        const document = await graphReadMap(command.params.mapId), grantBefore = workReadGrant(document, command.params)
        graphRequireRunOwnership(document, grantBefore.runId)
        const grant = await store.renew(command.params.mapId, command.params)
        if (!grant) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_EXPIRED_WAS_CANCELLED_OR_WAS_SUPERSEDED)
        return grant
      }
      if (command.method === 'read') {
        const input = command.params, document = await graphReadMap(input.mapId)
        if (document.leases[input.workId] && document.receipts.some(receipt => receipt.requestId === input.workId)) return { workId: input.workId, status: 'accepted' as const }
        const grant = workReadGrant(document, input)
        graphRequireRunOwnership(document, grant.runId)
        if (!await store.readLease(input.mapId, input)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        return { workId: input.workId, status: 'ready' as const }
      }
      if (command.method === 'release') return { released: await store.release(command.params.mapId, command.params) }
      const failure = command.params, failureId = `${failure.workId}:failure:${failure.fence}`
      const failureHash = storeCreateInputHash({ workId: failure.workId, message: failure.message })
      for (let attempt = 0; attempt < 64; attempt++) {
        const document = await graphReadMap(failure.mapId), grant = workReadGrant(document, failure)
        if (graphReadReceipt(document, failureId, 'work.fail', failureHash)) return { failed: true }
        if (document.receipts.some(receipt => receipt.requestId === failure.workId)) return { failed: false }
        if (!await store.readLease(failure.mapId, grant)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        const updated = structuredClone(document), run = updated.runs.find(item => item.id === grant.runId)
        if (!run) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_NO_LONGER_BELONGS_TO_THE_ACTIVE_RUN)
        graphRequireRunOwnership(document, grant.runId)
        const operation = runReadOperation(run, grant.operationId)
        operation.status = 'failed'; run.status = 'failed'; run.error = { code: 'WORK_FAILED', message: failure.message, workId: failure.workId }
        run.updatedAt = new Date().toISOString(); updated.updatedAt = run.updatedAt
        updated.ownershipRevision = document.ownershipRevision ?? 0
        if (graphReleaseRunOwnerships(updated, grant.runId)) updated.ownershipRevision++
        const receipt = graphCreateReceipt(failureId, 'work.fail', failureHash, run.updatedAt)
        try { await graphCommit(document, updated, receipt, grant, { ownershipRevision: document.ownershipRevision ?? 0, runId: grant.runId }); return { failed: true } }
        catch (error) { if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_CLAIM_AFTER_CONCURRENT_UPDATES_SETTLE)
    },

    /**
     * 来源正文只在缺失时通过受限读取器获取，并在返回模型前持久化到 Operation。
     *
     * @param mapId 内部 data_read 参数。
     * @param operationId Operation 身份。
     * @param proof 当前 Work 凭证。
     */
    async readData(
      /* 内部读取协议指定的目标图身份。 */ mapId: string,
      /* 必须与当前Work授权一致的Operation身份。 */ operationId: string,
      /* 当前Work的holder与fence租约证明。 */ proof: GraphWorkProof,
    ): Promise<GraphDataRead> {
      // 来源副作用前核对Work归属，冻结来源竞争后按新快照再次读取完整模型输入。
      const fetched = new Map<string, string>()
      for (let attempt = 0; attempt < 64; attempt++) {
        let document = await graphReadMap(mapId), grant = workReadGrant(document, proof)
        if (!await store.readLease(mapId, grant)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        const run = document.runs.find((/* 当前图中的一个活动Run。 */ item) => /* 读取租约明确绑定的Run。 */ item.id === grant.runId)
        if (!run) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_NO_LONGER_BELONGS_TO_THE_ACTIVE_RUN)
        graphRequireRunOwnership(document, grant.runId)
        const operation = runReadOperation(run, operationId)
        const stage = operation.executionSpec.stages.find((/* 请求Operation的冻结阶段声明。 */ item) => /* 按租约阶段身份读取来源绑定。 */ item.id === grant.stageId)
        if (!stage) throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.STAGE_WORK_IS_NOT_READY)
        const sourceBindings = Object.entries(stage.promptBindings).flatMap((/* 阶段中的变量名及冻结绑定声明。 */ [name, binding]) => {
          // 只有显式source-text绑定会产生受限外部读取。
          if (binding.source !== 'source-text') return []
          const refs = [...operation.group.inputRefs, ...operation.group.contextRefs].filter((/* Operation的冻结输入或上下文引用。 */ item) => /* 只读取绑定端口的来源节点。 */ item.port === binding.port)
          if (!refs.length) throw new GraphError(409, 'INPUT_STALE', RuntimeMessage.OPERATION_TARGET_IS_MISSING)
          return refs.map((/* 该来源端口中的一个精确输入引用。 */ ref) => /* 缓存键绑定阶段、变量、路径及输入内容版本。 */ ({ name, binding, ref,
            cacheKey: storeCreateInputHash({ stageId: stage.id, name, port: binding.port, path: binding.path, id: ref.id, revision: ref.revision }) }))
        })
        const missing = sourceBindings.filter((/* 本阶段的一项实际来源读取。 */ item) => /* 只补取尚未冻结的来源正文。 */ operation.externalInputs[item.cacheKey] === undefined)
        if (missing.length) runReadWorkContext(document, operationId, grant)
        for (const item of missing) {
          if (!options.readSource) throw new GraphError(422, 'SOURCE_UNREADABLE', RuntimeMessage.SOURCE_READER_IS_NOT_CONFIGURED)
          const node = document.nodes.find((/* 当前授权快照中的一个完整节点。 */ node) => /* 精确匹配已核对的来源身份和内容版本。 */ node.id === item.ref.id && node.revision === item.ref.revision)
          if (!node) throw new GraphError(409, 'INPUT_STALE', messageFormat(RuntimeMessage.OPERATION_INPUT_CHANGED_VALUE, item.ref.id))
          if (!fetched.has(item.cacheKey)) fetched.set(item.cacheKey, await options.readSource(document.workspaceId, node, item.binding.path))
        }
        if (missing.length) {
          const updated = structuredClone(document), nextRun = runReadRun(updated, grant.runId), nextOperation = runReadOperation(nextRun, operationId)
          for (const item of missing) nextOperation.externalInputs[item.cacheKey] = fetched.get(item.cacheKey)!
          updated.updatedAt = new Date().toISOString(); nextRun.updatedAt = updated.updatedAt
          const values = Object.fromEntries(missing.map((/* 本次已经取得正文的来源绑定。 */ item) => /* 把来源正文与其精确缓存键配对。 */ [item.cacheKey, fetched.get(item.cacheKey)!]))
          const keys = Object.keys(values).sort()
          // 同一冻结来源集合以首次成功提交的正文为准；并发读取动态 URL 即使返回不同正文，也重放赢家而不是形成幂等冲突。
          const hash = storeCreateInputHash({ operationId, keys })
          const receipt = graphCreateReceipt(`${operationId}:source:${storeCreateInputHash(keys)}`, 'source.read', hash, updated.updatedAt)
          try { document = (await graphCommit(document, updated, receipt, grant,
            { ownershipRevision: document.ownershipRevision ?? 0, runId: grant.runId })).document }
          catch (error) { if (error instanceof GraphError && error.code === 'REVISION_CONFLICT') continue; throw error }
          grant = workReadGrant(document, proof)
        }
        const stored = runReadOperation(runReadRun(document, grant.runId), operationId).externalInputs
        const sourceText = Object.fromEntries(Object.entries(stage.promptBindings).flatMap((/* 阶段中的变量名及冻结绑定声明。 */ [name, binding]) => {
          // 从CAS赢家保存的正文构造来源变量，不交付竞争失败者取得的动态内容。
          if (binding.source !== 'source-text') return []
          const values = sourceBindings.filter((/* 一项实际来源绑定。 */ item) => /* 汇总同一变量使用的所有来源。 */ item.name === name).map((/* 已属于该变量的来源绑定。 */ item) => /* 读取CAS赢家保存的正文。 */ stored[item.cacheKey]).filter((/* 赢家快照中的来源正文或未提供值。 */ value): value is string => /* 仅连接已经冻结的正文。 */ value !== undefined)
          return [[name, values.join('\n\n')]]
        }))
        const data = runReadData(document, operationId, grant, sourceText)
        return { ...data, work: { id: grant.workId, stageId: grant.stageId, slotId: grant.slotId, specHash: grant.specHash, status: 'ready' } }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_CLAIM_AFTER_CONCURRENT_UPDATES_SETTLE)
    },

    /**
     * 按冻结定义、输入版本和最终租约复验；合法 CAS 竞争重放同一提案，不重跑模型。
     *
     * @param mapId 图身份。
     * @param operationId Operation 身份。
     * @param proposal 通用阶段提案。
     * @param proof 当前 Work 凭证。
     */
    async propose(mapId: string, operationId: string, proposal: GraphDataProposal,
      proof: GraphWorkProof): Promise<GraphWriteResult> {
      if (proposal.operationId !== operationId) throw new GraphError(409, 'PROPOSAL_CONFLICT', RuntimeMessage.PROPOSAL_DOES_NOT_BELONG_TO_THIS_WORK_GRANT)
      const inputHash = storeCreateInputHash(proposal)
      for (let attempt = 0; attempt < 64; attempt++) {
        const document = await graphReadMap(mapId), grant = workReadGrant(document, proof)
        const replay = graphReadReceipt(document, proposal.id, 'data.propose', inputHash)
        if (replay) return graphWriteResult(document, replay)
        if (!await store.readLease(mapId, grant)) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_LEASE_IS_NOT_VALID)
        graphRequireRunOwnership(document, grant.runId)
        const result = runUpdateProposal(structuredClone(document), proposal, grant, new Date().toISOString())
        result.document.branchOwnerships = structuredClone(document.branchOwnerships ?? {})
        result.document.ownershipReceipts = structuredClone(document.ownershipReceipts ?? [])
        result.document.ownershipRevision = document.ownershipRevision ?? 0
        const run = runReadRun(result.document, grant.runId)
        if (['completed', 'failed', 'cancelled'].includes(run.status)) {
          if (graphReleaseRunOwnerships(result.document, run.id)) result.document.ownershipRevision++
        } else if (run?.branchState) {
          const conflict = branchFindOwnershipConflict(result.document, run.branchState.scope, await readNow(), run.id)
          if (conflict) throw new GraphError(409, 'BRANCH_BUSY', RuntimeMessage.BRANCH_OVERLAPS_ANOTHER_ACTIVE_OWNERSHIP)
        }
        if (options.assertOutputReferences && result.publishedNodes.length) {
          await options.assertOutputReferences(document.workspaceId, result.publishedNodes)
        }
        const receipt = graphCreateReceipt(proposal.id, 'data.propose', inputHash, result.document.updatedAt, result.nodeIds, result.edgeIds)
        try {
          const committed = await graphCommit(document, result.document, receipt, grant,
            { ownershipRevision: document.ownershipRevision ?? 0, runId: grant.runId })
          return graphWriteResult(committed.document, committed.receipt)
        }
        catch (error) { if (!(error instanceof GraphError) || error.code !== 'REVISION_CONFLICT') throw error }
      }
      throw new GraphError(503, 'WRITE_CONTENTION', RuntimeMessage.RETRY_PROPOSAL_AFTER_CONCURRENT_UPDATES_SETTLE)
    },
  }
}
