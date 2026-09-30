// 文件职责：解析业务与 Host HTTP 协议，组织认证、文件流、事件流和统一错误响应。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { activityIsStatus } from '../../../contracts/activity'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type {
  GraphChanges,
  GraphBranchProof,
  GraphBranchLeaseProof,
  GraphRunControlProof,
  GraphCommand,
  GraphFailure,
  GraphQuery,
  GraphWorkCommand,
  GraphWorkProof,
  GraphDataProposal,
  GraphSuccess,
} from '../../../contracts/graph'
import type { ControlCommand, ControlQuery } from '../../../contracts/control'
import { GraphError } from '../../modules/shared/domain-error'
import { graphInputReadAgentRef, graphInputReadDefinitionRef, graphInputReadNode, graphInputReadPayload } from '../../modules/graph/graph-input'
import type { ApplicationService } from '../../application/graph-application'
import { controlReadCommand, controlReadQuery } from '../../modules/workspace/workspace-input'
import { assetsReadCommand } from '../../modules/assets/asset-service'
import { eventsOpen } from './graph-event-stream'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'
import {
  inputReadObject as apiReadObject, inputReadString as apiReadString, inputReadId as apiReadId,
  inputReadRevision as apiReadRevision, inputReadArray as apiReadArray,
  inputReadNames as apiReadNames, inputReadIds as apiReadIds,
} from '../../modules/shared/input-validation'

const MAX_BODY_BYTES = 1_048_576
/**
 * 写出带 UTF-8 内容类型的 JSON 响应并结束请求。
 *
 * @param response 当前请求的 HTTP 响应，写出 JSON 后结束。
 * @param status 本次 JSON 响应使用的 HTTP 状态码。
 * @param body 已准备好的公共响应载荷，可包含成功数据或脱敏错误。
 */
function apiWriteJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
/**
 * 限制 JSON 请求体至 1 MiB，并将格式错误映射为客户端错误。
 *
 * @param request 未经验证的请求正文流，读取时累计检查大小。
 */
async function apiReadBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new GraphError(413, 'PAYLOAD_TOO_LARGE', RuntimeMessage.BODY_EXCEEDS_1_MIB)
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new GraphError(400, 'INVALID_JSON', RuntimeMessage.BODY_MUST_BE_VALID_JSON)
  }
}
/**
 * 解析图名称、节点和关系的批量增删输入，拒绝未知字段及非法类型。
 *
 * @param value 图编辑请求中的原始 changes 对象，需逐字段校验。
 */
function apiReadChanges(value: unknown): GraphChanges {
  const changes = apiReadObject(value, ['name', 'nodes', 'edges'], 'params.changes')
  const nodes = changes.nodes === undefined
    ? undefined
    : apiReadObject(changes.nodes, ['put', 'remove'], 'params.changes.nodes')
  const edges = changes.edges === undefined
    ? undefined
    : apiReadObject(changes.edges, ['put', 'remove'], 'params.changes.edges')
  return {
    name: changes.name === undefined ? undefined : apiReadString(changes.name, 'params.changes.name'),
    nodes: nodes && {
      put: nodes.put === undefined ? undefined : apiReadArray(nodes.put, 'params.changes.nodes.put').map((value, index) => {
        // 校验单个节点身份及对应类型的数据结构。
        return graphInputReadNode(value, `params.changes.nodes.put[${index}]`)
      }),
      remove: nodes.remove === undefined ? undefined : apiReadIds(nodes.remove, 'params.changes.nodes.remove'),
    },
    edges: edges && {
      put: edges.put === undefined ? undefined : apiReadArray(edges.put, 'params.changes.edges.put').map((value, index) => {
        // 校验单条关系的种类、身份与端点字段。
        const item = apiReadObject(value, ['id', 'kind', 'from', 'to', 'label'], `params.changes.edges.put[${index}]`)
        const kind = item.kind
        if (kind !== 'successor' && kind !== 'reference') {
          throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.EDGE_KIND_IS_INVALID)
        }
        return {
          id: apiReadId(item.id, 'edge.id'),
          kind,
          from: apiReadId(item.from, 'edge.from'),
          to: apiReadId(item.to, 'edge.to'),
          ...(item.label === undefined ? {} : { label: apiReadString(item.label, 'edge.label') }),
        }
      }),
      remove: edges.remove === undefined ? undefined : apiReadIds(edges.remove, 'params.changes.edges.remove'),
    },
  }
}
/**
 * 现有分支必须携带不透明版本；null 仅由领域层判定是否确为本次新建的独立根。
 *
 * @param value 人工编辑携带的分支根及其内容版本。
 */
function apiReadBranchProof(value: unknown): GraphBranchProof {
  const input = apiReadObject(value, ['rootIds', 'expectedVersion'], 'params.branch')
  const rootIds = apiReadIds(input.rootIds, 'params.branch.rootIds')
  if (!rootIds.length) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.BRANCH_ROOTS_MUST_NOT_BE_EMPTY)
  if (new Set(rootIds).size !== rootIds.length) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTAINS_DUPLICATE_IDS, 'params.branch.rootIds'))
  return {
    rootIds,
    expectedVersion: input.expectedVersion === null ? null : apiReadString(input.expectedVersion, 'params.branch.expectedVersion'),
  }
}
/**
 * @param value 客户端会话持有的分支租约证明。
 */
function apiReadBranchLeaseProof(value: unknown): GraphBranchLeaseProof {
  const input = apiReadObject(value, ['leaseId', 'holderId', 'fence'], 'params.lease')
  const fence = apiReadRevision(input.fence, 'params.lease.fence')
  if (fence < 1) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.FENCE_MUST_BE_POSITIVE)
  return { leaseId: apiReadId(input.leaseId, 'params.lease.leaseId'), holderId: apiReadId(input.holderId, 'params.lease.holderId'), fence }
}
/**
 * @param value 客户端窗口持有的 Run 控制租约。
 */
function apiReadRunControlProof(value: unknown): GraphRunControlProof {
  const input = apiReadObject(value, ['leaseId', 'holderId', 'fence'], 'params.control')
  const fence = apiReadRevision(input.fence, 'params.control.fence')
  if (fence < 1) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.FENCE_MUST_BE_POSITIVE)
  return { leaseId: apiReadId(input.leaseId, 'params.control.leaseId'), holderId: apiReadId(input.holderId, 'params.control.holderId'), fence }
}
/**
 * 按查询方法校验图、Run 或资产身份，其余查询交给工作区协议解析器。
 *
 * @param value 客户端原始查询信封，包含待验证的方法及参数。
 */
function apiReadQuery(value: unknown): GraphQuery | ControlQuery {
  const envelope = apiReadObject(value, ['method', 'params'], 'query')
  if (envelope.method === 'map.list') {
    const params = apiReadObject(envelope.params, ['workspaceId'], 'params')
    const workspaceId = apiReadId(params.workspaceId, 'params.workspaceId')
    return { method: envelope.method, params: { workspaceId } }
  }
  if (envelope.method === 'map.get') {
    const params = apiReadObject(envelope.params, ['mapId'], 'params')
    return { method: envelope.method, params: { mapId: apiReadId(params.mapId, 'params.mapId') } }
  }
  if (envelope.method === 'branch.get') {
    const params = apiReadObject(envelope.params, ['mapId', 'rootIds'], 'params')
    const rootIds = apiReadIds(params.rootIds, 'params.rootIds')
    if (!rootIds.length) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.BRANCH_ROOTS_MUST_NOT_BE_EMPTY)
    if (new Set(rootIds).size !== rootIds.length) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTAINS_DUPLICATE_IDS, 'params.rootIds'))
    return { method: envelope.method, params: { mapId: apiReadId(params.mapId, 'params.mapId'), rootIds } }
  }
  if (envelope.method === 'run.get') {
    const params = apiReadObject(envelope.params, ['mapId', 'runId'], 'params')
    return { method: 'run.get', params: { mapId: apiReadId(params.mapId, 'mapId'), runId: apiReadId(params.runId, 'runId') } }
  }
  if (envelope.method === 'asset.get') {
    const params = apiReadObject(envelope.params, ['assetId'], 'params')
    return { method: 'asset.get', params: { assetId: apiReadId(params.assetId, 'assetId') } }
  }
  return controlReadQuery(value)
}
/**
 * 来源只能绑定显式 scope 成员或一个已声明前序步骤的命名输出端口。
 *
 * @param value 运行步骤输入绑定的原始来源。
 * @param label 报错字段路径。
 */
function apiReadPlanSource(value: unknown, label: string) {
  const input = apiReadObject(value, ['kind', 'nodeIds', 'stepId', 'port'], label)
  if (input.kind === 'scope') {
    apiReadObject(value, ['kind', 'nodeIds'], label)
    return { kind: 'scope' as const, nodeIds: apiReadIds(input.nodeIds, `${label}.nodeIds`) }
  }
  if (input.kind === 'step') {
    apiReadObject(value, ['kind', 'stepId', 'port'], label)
    return { kind: 'step' as const, stepId: apiReadString(input.stepId, `${label}.stepId`), port: apiReadString(input.port, `${label}.port`) }
  }
  throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, label))
}
/**
 * @param value 运行步骤的输入或上下文绑定数组。
 * @param label 报错字段路径。
 */
function apiReadPlanBindings(value: unknown, label: string) {
  return apiReadArray(value, label).map((entry, index) => {
    const item = apiReadObject(entry, ['port', 'source'], `${label}[${index}]`)
    return { port: apiReadString(item.port, `${label}[${index}].port`), source: apiReadPlanSource(item.source, `${label}[${index}].source`) }
  })
}
/**
 * 这里只解析声明式 DAG；端口、类型、依赖和基数由冻结定义目录在 Run 创建时校验。
 *
 * @param value run.start 中尚未验证的有限步骤计划。
 */
function apiReadRunPlan(value: unknown): import('../../../contracts/graph').GraphRunPlan {
  const input = apiReadObject(value, ['steps'], 'params.plan')
  const steps = apiReadArray(input.steps, 'params.plan.steps').map((entry, index) => {
    const label = `params.plan.steps[${index}]`
    const item = apiReadObject(entry, ['id', 'transitionRef', 'dependsOn', 'input', 'context', 'grouping', 'onEmpty'], label)
    const grouping = apiReadObject(item.grouping, ['mode', 'groups'], `${label}.grouping`)
    let parsedGrouping: import('../../../contracts/graph').GraphPlanGrouping
    if (grouping.mode === 'each' || grouping.mode === 'all') {
      apiReadObject(item.grouping, ['mode'], `${label}.grouping`)
      parsedGrouping = { mode: grouping.mode }
    } else if (grouping.mode === 'explicit') {
      parsedGrouping = { mode: 'explicit', groups: apiReadArray(grouping.groups, `${label}.grouping.groups`).map((entry, groupIndex) => {
        const group = apiReadObject(entry, ['id', 'members'], `${label}.grouping.groups[${groupIndex}]`)
        if (!group.members || typeof group.members !== 'object' || Array.isArray(group.members)) {
          throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_OBJECT, `${label}.grouping.groups[${groupIndex}].members`))
        }
        const members = group.members as Record<string, unknown>
        return { id: apiReadString(group.id, 'group.id'), members: Object.fromEntries(Object.entries(members).map(([port, ids]) => [port, apiReadIds(ids, `members.${port}`)])) }
      }) }
    } else throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, `${label}.grouping`))
    if (item.onEmpty !== 'skip' && item.onEmpty !== 'fail') throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, `${label}.onEmpty`))
    return {
      id: apiReadString(item.id, `${label}.id`),
      transitionRef: graphInputReadDefinitionRef(item.transitionRef, `${label}.transitionRef`),
      dependsOn: apiReadNames(item.dependsOn, `${label}.dependsOn`),
      input: apiReadPlanBindings(item.input, `${label}.input`),
      context: apiReadPlanBindings(item.context, `${label}.context`),
      grouping: parsedGrouping,
      onEmpty: item.onEmpty as 'skip' | 'fail',
    }
  })
  return { steps }
}
/**
 * 按命令种类校验幂等身份、版本及业务参数，并分派资产和管理命令解析。
 *
 * @param value 客户端原始命令信封，需验证请求身份、方法及对应参数。
 */
function apiReadCommand(value: unknown): GraphCommand | ControlCommand {
  const envelope = apiReadObject(value, ['requestId', 'method', 'params'], 'command')
  const requestId = apiReadId(envelope.requestId, 'requestId')
  if (envelope.method === 'map.create') {
    const params = apiReadObject(envelope.params, ['workspaceId', 'expectedRevision', 'id', 'name'], 'params')
    const workspaceId = apiReadId(params.workspaceId, 'params.workspaceId')
    const revision = apiReadRevision(params.expectedRevision, 'params.expectedRevision')
    return {
      requestId,
      method: envelope.method,
      params: {
        workspaceId,
        expectedRevision: revision,
        id: apiReadId(params.id, 'params.id'),
        name: apiReadString(params.name, 'params.name'),
      },
    }
  }
  if (envelope.method === 'map.delete') {
    const params = apiReadObject(envelope.params, ['mapId', 'expectedRevision'], 'params')
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        expectedRevision: apiReadRevision(params.expectedRevision, 'params.expectedRevision'),
      },
    }
  }
  if (envelope.method === 'graph.apply') {
    const params = apiReadObject(envelope.params, ['mapId', 'branch', 'lease', 'changes'], 'params')
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        branch: apiReadBranchProof(params.branch),
        ...(params.lease === undefined ? {} : { lease: apiReadBranchLeaseProof(params.lease) }),
        changes: apiReadChanges(params.changes),
      },
    }
  }
  if (envelope.method === 'branch.claim') {
    const params = apiReadObject(envelope.params, ['mapId', 'rootIds', 'holderId'], 'params')
    const rootIds = apiReadIds(params.rootIds, 'params.rootIds')
    if (!rootIds.length || new Set(rootIds).size !== rootIds.length) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.BRANCH_ROOTS_MUST_NOT_BE_EMPTY)
    return { requestId, method: envelope.method, params: { mapId: apiReadId(params.mapId, 'params.mapId'), rootIds,
      holderId: apiReadId(params.holderId, 'params.holderId') } }
  }
  if (envelope.method === 'branch.renew' || envelope.method === 'branch.release') {
    const params = apiReadObject(envelope.params, ['mapId', 'lease'], 'params')
    return { requestId, method: envelope.method, params: { mapId: apiReadId(params.mapId, 'params.mapId'), lease: apiReadBranchLeaseProof(params.lease) } }
  }
  if (envelope.method === 'run.control.claim') {
    const params = apiReadObject(envelope.params, ['mapId', 'runId', 'holderId'], 'params')
    return { requestId, method: envelope.method, params: { mapId: apiReadId(params.mapId, 'params.mapId'),
      runId: apiReadId(params.runId, 'params.runId'), holderId: apiReadId(params.holderId, 'params.holderId') } }
  }
  if (envelope.method === 'run.control.renew' || envelope.method === 'run.control.release') {
    const params = apiReadObject(envelope.params, ['mapId', 'runId', 'control'], 'params')
    return { requestId, method: envelope.method, params: { mapId: apiReadId(params.mapId, 'params.mapId'),
      runId: apiReadId(params.runId, 'params.runId'), control: apiReadRunControlProof(params.control) } }
  }
  if (envelope.method === 'run.start') {
    const params = apiReadObject(
      envelope.params,
      ['mapId', 'id', 'branch', 'lease', 'scope', 'plan', 'mode', 'regenerate'],
      'params',
    )
    if (params.mode !== 'auto' && params.mode !== 'human-in-loop') {
      throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.PARAMS_MODE_IS_INVALID)
    }
    const branch = apiReadBranchProof(params.branch)
    if (branch.expectedVersion === null) {
      throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_A_NON_EMPTY_STRING, 'params.branch.expectedVersion'))
    }
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        id: apiReadId(params.id, 'params.id'),
        branch,
        ...(params.lease === undefined ? {} : { lease: apiReadBranchLeaseProof(params.lease) }),
        scope: { nodeIds: apiReadIds(apiReadObject(params.scope, ['nodeIds'], 'scope').nodeIds, 'scope.nodeIds') },
        plan: apiReadRunPlan(params.plan),
        ...(params.regenerate === undefined ? {} : { regenerate: apiReadBoolean(params.regenerate, 'regenerate') }),
        mode: params.mode,
      },
    }
  }
  if (envelope.method === 'run.cancel' || envelope.method === 'run.pause' || envelope.method === 'run.resume') {
    const params = apiReadObject(envelope.params, ['mapId', 'runId', 'control'], 'params')
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        runId: apiReadId(params.runId, 'params.runId'),
        ...(params.control === undefined ? {} : { control: apiReadRunControlProof(params.control) }),
      },
    }
  }
  if (envelope.method === 'review.answer') {
    const params = apiReadObject(
      envelope.params,
      ['mapId', 'runId', 'operationId', 'reviewId', 'expectedReviewRevision', 'decision', 'control'],
      'params',
    )
    if (params.decision !== 'approve' && params.decision !== 'reject') {
      throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.PARAMS_DECISION_IS_INVALID)
    }
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        runId: apiReadId(params.runId, 'params.runId'),
        operationId: apiReadString(params.operationId, 'operationId'),
        reviewId: apiReadId(params.reviewId, 'params.reviewId'),
        expectedReviewRevision: apiReadRevision(
          params.expectedReviewRevision,
          'params.expectedReviewRevision',
        ),
        decision: params.decision,
        ...(params.control === undefined ? {} : { control: apiReadRunControlProof(params.control) }),
      },
    }
  }
  if (envelope.method === 'asset.delete' || envelope.method === 'workspace.import') return assetsReadCommand(value)
  return controlReadCommand(value)
}
/**
 * 要求输入是真正的布尔值，避免字符串被隐式转换。
 *
 * @param value 待校验的布尔输入，不接受字符串或数字代替。
 * @param label 报错使用的字段路径，帮助调用者定位非法布尔值。
 */
function apiReadBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_BOOLEAN, label))
  return value
}
/**
 * 解析通用 outputs/selection/plan 信封；精确 schema、依赖和基数由 Operation 冻结合同复核。
 *
 * @param value Host 发送的原始提案载荷，需按提案种类收窄。
 */
function apiReadDataProposal(value: unknown): GraphDataProposal {
  const input = apiReadObject(value,
    ['mapId', 'operationId', 'id', 'specHash', 'kind', 'reason', 'outputs', 'selection', 'slots'], 'data.propose')
  const base = {
    mapId: apiReadId(input.mapId, 'mapId'),
    operationId: apiReadString(input.operationId, 'operationId'),
    id: apiReadString(input.id, 'id'),
    specHash: apiReadString(input.specHash, 'specHash'),
    reason: apiReadString(input.reason, 'reason'),
  }
  if (input.kind === 'outputs') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'specHash', 'kind', 'reason', 'outputs'], 'outputs')
    const outputs = apiReadArray(input.outputs, 'outputs')
    if (outputs.length > 256) throw new GraphError(413, 'OUTPUT_LIMIT', RuntimeMessage.AT_MOST_256_OUTPUTS_PER_OPERATION)
    return { ...base, kind: 'outputs', outputs: outputs.map((entry, index) => {
      const item = apiReadObject(entry, ['key', 'port', 'typeRef', 'payload', 'sourceKeys'], `outputs[${index}]`)
      return {
        key: apiReadString(item.key, `outputs[${index}].key`),
        port: apiReadString(item.port, `outputs[${index}].port`),
        typeRef: graphInputReadDefinitionRef(item.typeRef, `outputs[${index}].typeRef`),
        payload: graphInputReadPayload(item.payload, `outputs[${index}].payload`),
        ...(item.sourceKeys === undefined ? {} : { sourceKeys: apiReadNames(item.sourceKeys, `outputs[${index}].sourceKeys`) }),
      }
    }) }
  }
  if (input.kind === 'selection') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'specHash', 'kind', 'reason', 'selection'], 'selection')
    const selection = apiReadArray(input.selection, 'selection')
    if (selection.length > 256) throw new GraphError(413, 'OUTPUT_LIMIT', RuntimeMessage.AT_MOST_256_CANDIDATES_PER_OPERATION)
    return { ...base, kind: 'selection', selection: selection.map((entry, index) => {
      const item = apiReadObject(entry, ['workId', 'key'], `selection[${index}]`)
      return { workId: apiReadString(item.workId, `selection[${index}].workId`), key: apiReadString(item.key, `selection[${index}].key`) }
    }) }
  }
  if (input.kind === 'plan') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'specHash', 'kind', 'reason', 'slots'], 'plan')
    const slots = apiReadArray(input.slots, 'slots')
    if (slots.length > 256) throw new GraphError(413, 'OUTPUT_LIMIT', RuntimeMessage.AT_MOST_256_CANDIDATES_PER_OPERATION)
    return { ...base, kind: 'plan', slots: slots.map((entry, index) => {
      const item = apiReadObject(entry, ['id', 'stageId', 'agentRef', 'angle', 'hint', 'priority', 'tools'], `slots[${index}]`)
      if (!['high', 'medium', 'low'].includes(item.priority as string)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_SLOT_PRIORITY)
      return {
        id: apiReadString(item.id, `slots[${index}].id`),
        stageId: apiReadString(item.stageId, `slots[${index}].stageId`),
        agentRef: graphInputReadAgentRef(item.agentRef, `slots[${index}].agentRef`),
        angle: apiReadString(item.angle, `slots[${index}].angle`),
        hint: typeof item.hint === 'string' ? item.hint : (() => { throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.SLOT_HINT_MUST_BE_A_STRING) })(),
        priority: item.priority as 'high' | 'medium' | 'low',
        tools: apiReadNames(item.tools, `slots[${index}].tools`),
      }
    }) }
  }
  throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.PROPOSAL_KIND_IS_INVALID)
}
/**
 * 核对配置的内部 Host Bearer 令牌，等长字节使用恒定时间比较。
 *
 * @param request 携带 Authorization 头的内部请求，头内容仍不可信。
 * @param token 部署配置的内部 Host 令牌；缺失时内部请求一律拒绝。
 */
function apiValidateToken(request: IncomingMessage, token: string | undefined): void {
  const supplied = request.headers.authorization
  const expected = token ? `Bearer ${token}` : ''
  if (!expected || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new GraphError(401, 'UNAUTHORIZED', RuntimeMessage.INTERNAL_API_REQUIRES_A_CONFIGURED_HOST_TOKEN)
  }
}
/**
 * 从 Authorization 头提取非空用户令牌，身份有效性由应用层验证。
 *
 * @param request 携带用户 Authorization 头的请求，此处只提取令牌字符串。
 */
function apiReadUserToken(request: IncomingMessage): string {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw new GraphError(401, 'UNAUTHORIZED', RuntimeMessage.A_USER_TOKEN_IS_REQUIRED)
  return header.slice(7)
}
/**
 * 限制工作身份的字符集合与长度，供租约索引使用。
 *
 * @param value 未经校验的工作身份，字符和长度必须符合租约键约定。
 */
function apiReadWorkId(value: unknown): string {
  const workId = apiReadString(value, 'workId')
  if (!/^[a-zA-Z0-9_:-]{1,512}$/.test(workId)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.WORKID_IS_INVALID)
  return workId
}
/**
 * 校验工作身份、持有者 UUID 与正整数栅栏版本。
 *
 * @param input 已经确认是对象的原始工作凭证字段，仍需逐项验证。
 */
function apiReadProof(input: Record<string, unknown>): GraphWorkProof {
  const workId = apiReadWorkId(input.workId)
  const fence = apiReadRevision(input.fence, 'fence')
  if (fence < 1) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.FENCE_MUST_BE_POSITIVE)
  return { workId, holderId: apiReadId(input.holderId, 'holderId'), fence }
}
/**
 * 从工作请求头解析租约凭证，拒绝缺失或非十进制的 fence。
 *
 * @param request 携带 x-work-id、x-work-holder 和 x-work-fence 的内部请求。
 */
function apiReadWorkProof(request: IncomingMessage): GraphWorkProof {
  const fence = request.headers['x-work-fence']
  if (typeof fence !== 'string' || !/^[1-9][0-9]*$/.test(fence)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.X_WORK_FENCE_IS_REQUIRED)
  return apiReadProof({ workId: request.headers['x-work-id'], holderId: request.headers['x-work-holder'], fence: Number(fence) })
}
/**
 * 校验工作领取或租约操作参数，并限制 Host 身份和失败消息长度。
 *
 * @param value 未经验证的领取、续租、读取、释放或失败命令信封。
 */
function apiReadWorkCommand(value: unknown): GraphWorkCommand {
  const input = apiReadObject(value, ['method', 'params'], 'work')
  if (input.method === 'claim') {
    const params = apiReadObject(input.params, ['hostId', 'holderId', 'mapId', 'workId', 'deploymentId'], 'params')
    const hostId = apiReadString(params.hostId, 'hostId')
    if (hostId.length > 128) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.HOSTID_EXCEEDS_128_CHARACTERS)
    return { method: 'claim', params: { hostId, holderId: apiReadId(params.holderId, 'holderId'),
      mapId: apiReadId(params.mapId, 'mapId'), workId: apiReadWorkId(params.workId), deploymentId: apiReadId(params.deploymentId, 'deploymentId'),
    } }
  }
  if (input.method !== 'read' && input.method !== 'renew' && input.method !== 'release' && input.method !== 'fail') {
    throw new GraphError(400, 'UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_WORK_METHOD)
  }
  const params = apiReadObject(input.params,
    ['mapId', 'workId', 'holderId', 'fence', ...(input.method === 'fail' ? ['message'] : [])], 'params')
  const proof = { mapId: apiReadId(params.mapId, 'mapId'), ...apiReadProof(params) }
  if (input.method === 'fail') {
    const message = apiReadString(params.message, 'message')
    if (message.length > 1000) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.MESSAGE_EXCEEDS_1000_CHARACTERS)
    return { method: 'fail', params: { ...proof, message } }
  }
  return { method: input.method, params: proof }
}
/**
 * 将领域错误写成公共失败响应，对未知异常脱敏并生成诊断编号。
 *
 * @param response 尚未发送响应头的 HTTP 输出流，函数将结束错误响应。
 * @param requestId 关联本次命令或请求的身份，随失败信封返回。
 * @param error 请求执行期间捕获的异常，未知异常不得直接暴露给客户端。
 * @param reporter 可选内部诊断报告器，用于保存原始故障及生成错误编号。
 * @param route 可选请求路径，只取有界文本作为诊断上下文。
 */
function apiWriteError(response: ServerResponse, requestId: string, error: unknown, reporter?: DiagnosticReporter, route?: string): void {
  const graphError = error instanceof GraphError
    ? error
    : new GraphError(500, 'INTERNAL_ERROR', RuntimeMessage.INTERNAL_SERVER_ERROR)
  const errorId = graphError.status >= 500
    ? reporter?.report({ name: 'request.failed', severity: 'error', context: { requestId, route: route?.slice(0, 256) ?? 'unknown' }, error }) ?? randomUUID()
    : randomUUID()
  const body: GraphFailure = {
    ok: false,
    requestId,
    error: {
      code: graphError.code,
      message: graphError.message,
      retryable: graphError.status >= 500,
      errorId,
      ...(graphError.currentRevision === undefined ? {} : { currentRevision: graphError.currentRevision }),
    },
  }
  apiWriteJson(response, graphError.status, body)
}
/**
 * 组装业务、内部 Host 和文件 HTTP 入口，并提供拒绝新写入的关闭标记。
 *
 * @param application 由部署入口组装的应用服务，承担身份、权限与业务事务。
 * @param options 可选内部令牌及诊断配置；默认空对象，令牌可回退到环境配置。
 */
export function apiCreateServer(
  application: ApplicationService,
  options: { internalToken?: string; reporter?: DiagnosticReporter } = {},
): Server & {
  // 进入停止接收新写入、领取与订阅的阶段；现有连接由后续 close 负责排空。
  beginShutdown(): void
} {
  const internalToken = options.internalToken ?? process.env.CHONGMING_DATA_TOKEN
  const service = application.graph
  const streams = new Set<ServerResponse>()
  let stopping = false
  const server = createServer(async (request, response) => {
    // 路由并验证请求，在授权后执行对应业务；流开始后的异常改为终止连接。
    let requestId: string = randomUUID()
    try {
      if (request.method === 'GET' && request.url === '/health') {
        apiWriteJson(response, stopping ? 503 : 200, { ok: true, ready: !stopping })
        return
      }
      if (request.method === 'GET' && request.url === '/internal/v1/messaging') {
        apiValidateToken(request, internalToken)
        apiWriteJson(response, 200, { ok: true, data: application.messaging() })
        return
      }
      if (request.method === 'POST' && request.url === '/internal/v1/data/read') {
        apiValidateToken(request, internalToken)
        const proof = apiReadWorkProof(request)
        const input = apiReadObject(await apiReadBody(request), ['mapId', 'operationId'], 'data.read')
        const mapId = apiReadId(input.mapId, 'mapId')
        const operationId = apiReadString(input.operationId, 'operationId')
        apiWriteJson(response, 200, { ok: true, data: await service.readData(mapId, operationId, proof) })
        return
      }
      if (request.method === 'POST' && request.url === '/internal/v1/data/propose') {
        apiValidateToken(request, internalToken)
        const proof = apiReadWorkProof(request)
        const input = apiReadDataProposal(await apiReadBody(request))
        apiWriteJson(response, 200, { ok: true, data: await service.propose(input.mapId, input.operationId, input, proof) })
        return
      }
      if (request.method === 'POST' && request.url === '/internal/v1/activity') {
        apiValidateToken(request, internalToken)
        const proof = apiReadWorkProof(request)
        const input = apiReadObject(await apiReadBody(request), ['mapId', 'status', 'sequence'], 'activity')
        if (!activityIsStatus(input.status) || !Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_ACTIVITY_STATUS_OR_SEQUENCE)
        await application.publishActivity(apiReadId(input.mapId, 'mapId'), proof, input.status, Number(input.sequence))
        apiWriteJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && request.url === '/internal/v1/work') {
        apiValidateToken(request, internalToken)
        const command = apiReadWorkCommand(await apiReadBody(request))
        if (stopping && command.method === 'claim') throw new GraphError(503, 'SERVICE_STOPPING', RuntimeMessage.SERVICE_IS_STOPPING)
        if (command.method === 'claim' && command.params.deploymentId !== application.messaging().deploymentId) {
          throw new GraphError(409, 'DEPLOYMENT_MISMATCH', RuntimeMessage.WORK_BELONGS_TO_A_DIFFERENT_DEPLOYMENT)
        }
        apiWriteJson(response, 200, { ok: true, data: await service.dispatchWork(command) })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const events = /^\/api\/v1\/maps\/([^/]+)\/events$/.exec(url.pathname)
      if (request.method === 'GET' && events) {
        if (stopping) throw new GraphError(503, 'SERVICE_STOPPING', RuntimeMessage.SERVICE_IS_STOPPING)
        if (url.search) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.EVENT_STREAMS_DO_NOT_ACCEPT_QUERY_PARAMETERS)
        const token = apiReadUserToken(request)
        const mapId = apiReadId(events[1], 'mapId')
        streams.add(response)
        try { await eventsOpen(application, token, mapId, response, options.reporter ? { reporter: options.reporter, requestId } : undefined) }
        finally { streams.delete(response) }
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/assets') {
        if (stopping) throw new GraphError(503, 'SERVICE_STOPPING', RuntimeMessage.SERVICE_IS_STOPPING)
        const token = apiReadUserToken(request)
        if ([...url.searchParams.keys()].some(key => /* 拒绝上传 URL 中未声明的参数。 */  !['workspaceId', 'filename'].includes(key))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.UNKNOWN_UPLOAD_PARAMETER)
        const length = request.headers['content-length']
        if (typeof length !== 'string' || !/^[0-9]+$/.test(length)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.CONTENT_LENGTH_IS_REQUIRED)
        const size = Number(length)
        if (!Number.isSafeInteger(size)) throw new GraphError(413, 'PAYLOAD_TOO_LARGE', RuntimeMessage.ASSET_IS_TOO_LARGE)
        requestId = apiReadId(request.headers['idempotency-key'], 'Idempotency-Key')
        const result = await application.assets.upload(token, {
          workspaceId: apiReadId(url.searchParams.get('workspaceId'), 'workspaceId'),
          filename: apiReadString(url.searchParams.get('filename'), 'filename'),
          mediaType: apiReadString(request.headers['content-type'], 'Content-Type'),
          sha256: apiReadString(request.headers['x-content-sha256'], 'X-Content-SHA256'), size, requestId,
        }, request)
        apiWriteJson(response, result.replayed ? 200 : 201, { ok: true, requestId, ...result })
        return
      }
      const download = /^\/api\/v1\/assets\/([^/]+)\/content$/.exec(url.pathname)
      if (request.method === 'GET' && download) {
        const ctx = await application.auth.read(apiReadUserToken(request))
        const { asset, stream } = await application.assets.content(ctx, apiReadId(download[1], 'assetId'))
        response.writeHead(200, {
          'content-type': asset.mediaType, 'content-length': asset.size, etag: `"${asset.sha256}"`,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
        })
        await pipeline(stream, response)
        return
      }
      const exported = /^\/api\/v1\/(maps|workspaces)\/([^/]+)\/export$/.exec(url.pathname)
      if (request.method === 'GET' && exported) {
        const ctx = await application.auth.read(apiReadUserToken(request))
        const id = apiReadId(exported[2], 'id')
        const bundle = exported[1] === 'maps' ? await application.assets.exportMap(ctx, id) : await application.assets.exportWorkspace(ctx, id)
        const body = Buffer.from(JSON.stringify(bundle))
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length,
          'content-disposition': `attachment; filename="${exported[1]}-${id}.json"`,
        })
        response.end(body)
        return
      }
      if (request.method !== 'POST' || !['/api/v1/query', '/api/v1/command'].includes(request.url ?? '')) {
        throw new GraphError(404, 'NOT_FOUND', RuntimeMessage.NOT_FOUND)
      }
      const token = apiReadUserToken(request)
      const body = await apiReadBody(request)
      if (request.url === '/api/v1/query') {
        const data = await application.read(token, apiReadQuery(body))
        const result: GraphSuccess<typeof data> = { ok: true, requestId, replayed: false, data }
        apiWriteJson(response, 200, result)
        return
      }
      if (stopping) throw new GraphError(503, 'SERVICE_STOPPING', RuntimeMessage.SERVICE_IS_STOPPING)
      const command = apiReadCommand(body)
      requestId = command.requestId
      const result = await application.dispatch(token, command)
      const bodyResult: GraphSuccess<typeof result.data> = {
        ok: true,
        requestId,
        replayed: result.replayed,
        data: result.data,
      }
      apiWriteJson(response, ['map.create', 'workspace.create', 'workspace.import', 'agent.create'].includes(command.method) && !result.replayed ? 201 : 200, bodyResult)
    } catch (error) {
      if (response.headersSent) {
        options.reporter?.report({ name: 'response.stream.failed', severity: 'error', context: { requestId, route: request.url?.split('?')[0].slice(0, 256) ?? 'unknown' }, error })
        response.destroy()
      } else {
        try { apiWriteError(response, requestId, error, options.reporter, request.url?.split('?')[0]) }
        catch (writeError) {
          options.reporter?.report({ name: 'response.error.failed', severity: 'error', context: { requestId }, error: writeError })
          response.destroy()
        }
      }
    }
  })
  const close = server.close.bind(server)
  Object.assign(server, {
    beginShutdown() {
      // 标记服务停止接收新的领取、订阅和业务写入。
       stopping = true } })
  server.close = callback => {
    // 关闭全部 SSE 响应后转交原 HTTP Server 的关闭操作。
    for (const stream of streams) stream.destroy()
    return close(callback)
  }
  return server as Server & {
    // 标记停止接收新业务，供运行入口在关闭 HTTP 服务前先降低就绪状态。
    beginShutdown(): void
  }
}
