// 文件职责：解析业务与 Host HTTP 协议，组织认证、文件流、事件流和统一错误响应。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { activityIsStatus } from '../../../contracts/activity'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type {
  GraphChanges,
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
import { graphInputReadNodeData } from '../../modules/graph/graph-input'
import type { ApplicationService } from '../../application/graph-application'
import { controlReadCommand, controlReadQuery } from '../../modules/workspace/workspace-input'
import { assetsReadCommand } from '../../modules/assets/asset-service'
import { eventsOpen } from './graph-event-stream'
import { configurationReadSlots } from '../../modules/workspace/agent-configuration'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'
import {
  inputReadObject as apiReadObject, inputReadString as apiReadString, inputReadId as apiReadId,
  inputReadRevision as apiReadRevision, inputReadArray as apiReadArray,
  inputReadNames as apiReadNames, inputReadScore as apiReadScore, inputReadIds as apiReadIds,
} from '../../modules/shared/input-validation'

const MAX_BODY_BYTES = 1_048_576
function apiWriteJson(/* 当前请求的 HTTP 响应，写出 JSON 后结束。 */ response: ServerResponse, /* 本次 JSON 响应使用的 HTTP 状态码。 */ status: number, /* 已准备好的公共响应载荷，可包含成功数据或脱敏错误。 */ body: unknown): void {
  // 写出带 UTF-8 内容类型的 JSON 响应并结束请求。
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
async function apiReadBody(/* 未经验证的请求正文流，读取时累计检查大小。 */ request: IncomingMessage): Promise<unknown> {
  // 限制 JSON 请求体至 1 MiB，并将格式错误映射为客户端错误。
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
function apiReadChanges(/* 图编辑请求中的原始 changes 对象，需逐字段校验。 */ value: unknown): GraphChanges {
  // 解析图名称、节点和关系的批量增删输入，拒绝未知字段及非法类型。
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
      put: nodes.put === undefined ? undefined : apiReadArray(nodes.put, 'params.changes.nodes.put').map((/* 本批待新增或更新节点的原始 JSON 条目。 */ value, /* 节点在提交数组中的位置，用于生成准确的校验字段路径。 */ index) => {
        // 校验单个节点身份及对应类型的数据结构。
        const item = apiReadObject(value, ['id', 'data'], `params.changes.nodes.put[${index}]`)
        return { id: apiReadId(item.id, 'node.id'), data: graphInputReadNodeData(item.data, 'node.data') }
      }),
      remove: nodes.remove === undefined ? undefined : apiReadIds(nodes.remove, 'params.changes.nodes.remove'),
    },
    edges: edges && {
      put: edges.put === undefined ? undefined : apiReadArray(edges.put, 'params.changes.edges.put').map((/* 本批待新增或更新关系的原始 JSON 条目。 */ value, /* 关系在提交数组中的位置，用于生成准确的校验字段路径。 */ index) => {
        // 校验单条关系的种类、身份与端点字段。
        const item = apiReadObject(value, ['id', 'kind', 'from', 'to'], `params.changes.edges.put[${index}]`)
        const kind = item.kind
        if (kind !== 'derived-from' && kind !== 'mentions' && kind !== 'verifies' && kind !== 'related-to') {
          throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.EDGE_KIND_IS_INVALID)
        }
        return {
          id: apiReadId(item.id, 'edge.id'),
          kind,
          from: apiReadId(item.from, 'edge.from'),
          to: apiReadId(item.to, 'edge.to'),
        }
      }),
      remove: edges.remove === undefined ? undefined : apiReadIds(edges.remove, 'params.changes.edges.remove'),
    },
  }
}
function apiReadQuery(/* 客户端原始查询信封，包含待验证的方法及参数。 */ value: unknown): GraphQuery | ControlQuery {
  // 按查询方法校验图、Run 或资产身份，其余查询交给工作区协议解析器。
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
function apiReadCommand(/* 客户端原始命令信封，需验证请求身份、方法及对应参数。 */ value: unknown): GraphCommand | ControlCommand {
  // 按命令种类校验幂等身份、版本及业务参数，并分派资产和管理命令解析。
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
    const params = apiReadObject(envelope.params, ['mapId', 'expectedRevision', 'changes'], 'params')
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        expectedRevision: apiReadRevision(params.expectedRevision, 'params.expectedRevision'),
        changes: apiReadChanges(params.changes),
      },
    }
  }
  if (envelope.method === 'run.start') {
    const params = apiReadObject(
      envelope.params,
      ['mapId', 'expectedRevision', 'id', 'scope', 'until', 'mode', 'regenerate'],
      'params',
    )
    if (params.mode !== 'auto' && params.mode !== 'human-in-loop') {
      throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.PARAMS_MODE_IS_INVALID)
    }
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        expectedRevision: apiReadRevision(params.expectedRevision, 'params.expectedRevision'),
        id: apiReadId(params.id, 'params.id'),
        scope: { nodeIds: apiReadIds(apiReadObject(params.scope, ['nodeIds'], 'scope').nodeIds, 'scope.nodeIds') },
        until: apiReadUntil(params.until),
        ...(params.regenerate === undefined ? {} : { regenerate: apiReadBoolean(params.regenerate, 'regenerate') }),
        mode: params.mode,
      },
    }
  }
  if (envelope.method === 'run.cancel' || envelope.method === 'run.pause' || envelope.method === 'run.resume') {
    const params = apiReadObject(envelope.params, ['mapId', 'expectedRevision', 'runId'], 'params')
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        expectedRevision: apiReadRevision(params.expectedRevision, 'params.expectedRevision'),
        runId: apiReadId(params.runId, 'params.runId'),
      },
    }
  }
  if (envelope.method === 'review.update') {
    const params = apiReadObject(envelope.params,
      ['mapId', 'expectedRevision', 'runId', 'operationId', 'reviewId', 'expectedReviewRevision', 'reason', 'slots'], 'params')
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        expectedRevision: apiReadRevision(params.expectedRevision, 'params.expectedRevision'),
        runId: apiReadId(params.runId, 'params.runId'),
        operationId: apiReadString(params.operationId, 'operationId'),
        reviewId: apiReadId(params.reviewId, 'params.reviewId'),
        expectedReviewRevision: apiReadRevision(params.expectedReviewRevision, 'params.expectedReviewRevision'),
        reason: apiReadString(params.reason, 'params.reason'),
        slots: configurationReadSlots(params.slots),
      },
    }
  }
  if (envelope.method === 'review.answer') {
    const params = apiReadObject(
      envelope.params,
      ['mapId', 'expectedRevision', 'runId', 'operationId', 'reviewId', 'expectedReviewRevision', 'decision'],
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
        expectedRevision: apiReadRevision(params.expectedRevision, 'params.expectedRevision'),
        runId: apiReadId(params.runId, 'params.runId'),
        operationId: apiReadString(params.operationId, 'operationId'),
        reviewId: apiReadId(params.reviewId, 'params.reviewId'),
        expectedReviewRevision: apiReadRevision(
          params.expectedReviewRevision,
          'params.expectedReviewRevision',
        ),
        decision: params.decision,
      },
    }
  }
  if (envelope.method === 'asset.delete' || envelope.method === 'workspace.import') return assetsReadCommand(value)
  return controlReadCommand(value)
}
function apiReadBoolean(/* 待校验的布尔输入，不接受字符串或数字代替。 */ value: unknown, /* 报错使用的字段路径，帮助调用者定位非法布尔值。 */ label: string): boolean {
  // 要求输入是真正的布尔值，避免字符串被隐式转换。
  if (typeof value !== 'boolean') throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_BOOLEAN, label))
  return value
}
function apiReadUntil(/* 客户端指定的运行终点，必须属于支持的三个业务阶段。 */ value: unknown): 'news' | 'claims' | 'verified' {
  // 将执行终点限制为新闻、事实或已核查三种阶段。
  if (value !== 'news' && value !== 'claims' && value !== 'verified') throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.UNTIL_MUST_BE_NEWS_CLAIMS_OR_VERIFIED)
  return value
}
function apiReadOutputs(/* 解析提案中的原始新闻数组，尚未验证内容和上下文。 */ value: unknown, /* 固定为新闻的输出种类，同时确定重载返回类型。 */ kind: 'news'): import('../../../contracts/graph').GraphNewsOutput[]
function apiReadOutputs(/* 拆分报告中的原始事实数组，尚未验证内容和分类。 */ value: unknown, /* 固定为事实的输出种类，同时确定重载返回类型。 */ kind: 'claim'): import('../../../contracts/graph').GraphClaimOutput[]
function apiReadOutputs(/* 待验证的模型产物数组，单次 Operation 最多接受 256 条。 */ value: unknown, /* 本次产物的业务种类，决定允许的字段及返回结构。 */ kind: 'news' | 'claim') {
  // 验证至多 256 条新闻或事实产物，并投影为对应输出结构。
  const items = apiReadArray(value, kind)
  if (items.length > 256) throw new GraphError(413, 'OUTPUT_LIMIT', RuntimeMessage.AT_MOST_256_OUTPUTS_PER_OPERATION)
  return items.map(/* 新闻或事实数组中的单个未验证产物。 */ value => {
    // 按产物类型校验内容及上下文或分类，剔除不属于输出协议的字段。
    const item = apiReadObject(value, kind === 'news' ? ['content', 'context'] : ['content', 'category'], kind)
    const node = graphInputReadNodeData({ ...item, kind }, kind)
    if (node.kind === 'news') return { content: node.content, context: node.context }
    if (node.kind === 'claim') return { content: node.content, category: node.category }
    throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_OUTPUT_KIND)
  })
}
function apiReadDataProposal(/* Host 发送的原始提案载荷，需按提案种类收窄。 */ value: unknown): GraphDataProposal {
  // 按提案类型校验路由、报告、候选选择与汇总参数，建立可信提交结构。
  const input = apiReadObject(value,
    ['mapId', 'operationId', 'id', 'kind', 'reason', 'slots', 'routeRevision', 'slotId', 'score', 'reportIds', 'news', 'claims', 'selected'], 'data.propose')
  const base = {
    mapId: apiReadId(input.mapId, 'mapId'),
    operationId: apiReadString(input.operationId, 'operationId'),
    id: apiReadString(input.id, 'id'),
    reason: apiReadString(input.reason, 'reason'),
  }
  if (input.kind === 'route') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'kind', 'reason', 'slots'], 'route')
    return { ...base, kind: 'route', slots: configurationReadSlots(input.slots) }
  }
  if (input.kind === 'parse') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'kind', 'reason', 'news'], 'parse')
    return { ...base, kind: 'parse', news: apiReadOutputs(input.news, 'news') }
  }
  const routeRevision = apiReadRevision(input.routeRevision, 'routeRevision')
  if (input.kind === 'split-report') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'kind', 'reason', 'routeRevision', 'slotId', 'claims'], 'split-report')
    return { ...base, kind: 'split-report', routeRevision, slotId: apiReadString(input.slotId, 'slotId'), claims: apiReadOutputs(input.claims, 'claim') }
  }
  if (input.kind === 'split-merge') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'kind', 'reason', 'routeRevision', 'reportIds', 'selected'], 'split-merge')
    const selected = apiReadArray(input.selected, 'selected').map(/* 拆分汇总中的单个候选引用，含报告身份与候选索引。 */ value => {
      // 校验被选候选的报告身份与非负整数索引。
      const item = apiReadObject(value, ['reportId', 'index'], 'selection')
      return { reportId: apiReadString(item.reportId, 'reportId'), index: apiReadRevision(item.index, 'index') }
    })
    if (selected.length > 256) throw new GraphError(413, 'OUTPUT_LIMIT', RuntimeMessage.AT_MOST_256_CANDIDATES_PER_OPERATION)
    return { ...base, kind: 'split-merge', routeRevision, reportIds: apiReadNames(input.reportIds, 'reportIds'), selected }
  }
  const score = apiReadScore(input.score)
  if (input.kind === 'report') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'kind', 'reason', 'routeRevision', 'slotId', 'score'], 'report')
    return { ...base, kind: 'report', routeRevision, score, slotId: apiReadString(input.slotId, 'slotId') }
  }
  if (input.kind === 'merge') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'kind', 'reason', 'routeRevision', 'reportIds', 'score'], 'merge')
    return { ...base, kind: 'merge', routeRevision, score, reportIds: apiReadNames(input.reportIds, 'reportIds') }
  }
  throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.PROPOSAL_KIND_IS_INVALID)
}
function apiValidateToken(/* 携带 Authorization 头的内部请求，头内容仍不可信。 */ request: IncomingMessage, /* 部署配置的内部 Host 令牌；缺失时内部请求一律拒绝。 */ token: string | undefined): void {
  // 核对配置的内部 Host Bearer 令牌，等长字节使用恒定时间比较。
  const supplied = request.headers.authorization
  const expected = token ? `Bearer ${token}` : ''
  if (!expected || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new GraphError(401, 'UNAUTHORIZED', RuntimeMessage.INTERNAL_API_REQUIRES_A_CONFIGURED_HOST_TOKEN)
  }
}
function apiReadUserToken(/* 携带用户 Authorization 头的请求，此处只提取令牌字符串。 */ request: IncomingMessage): string {
  // 从 Authorization 头提取非空用户令牌，身份有效性由应用层验证。
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw new GraphError(401, 'UNAUTHORIZED', RuntimeMessage.A_USER_TOKEN_IS_REQUIRED)
  return header.slice(7)
}
function apiReadWorkId(/* 未经校验的工作身份，字符和长度必须符合租约键约定。 */ value: unknown): string {
  // 限制工作身份的字符集合与长度，供租约索引使用。
  const workId = apiReadString(value, 'workId')
  if (!/^[a-zA-Z0-9_:-]{1,256}$/.test(workId)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.WORKID_IS_INVALID)
  return workId
}
function apiReadProof(/* 已经确认是对象的原始工作凭证字段，仍需逐项验证。 */ input: Record<string, unknown>): GraphWorkProof {
  // 校验工作身份、持有者 UUID 与正整数栅栏版本。
  const workId = apiReadWorkId(input.workId)
  const fence = apiReadRevision(input.fence, 'fence')
  if (fence < 1) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.FENCE_MUST_BE_POSITIVE)
  return { workId, holderId: apiReadId(input.holderId, 'holderId'), fence }
}
function apiReadWorkProof(/* 携带 x-work-id、x-work-holder 和 x-work-fence 的内部请求。 */ request: IncomingMessage): GraphWorkProof {
  // 从工作请求头解析租约凭证，拒绝缺失或非十进制的 fence。
  const fence = request.headers['x-work-fence']
  if (typeof fence !== 'string' || !/^[1-9][0-9]*$/.test(fence)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.X_WORK_FENCE_IS_REQUIRED)
  return apiReadProof({ workId: request.headers['x-work-id'], holderId: request.headers['x-work-holder'], fence: Number(fence) })
}
function apiReadWorkCommand(/* 未经验证的领取、续租、读取、释放或失败命令信封。 */ value: unknown): GraphWorkCommand {
  // 校验工作领取或租约操作参数，并限制 Host 身份和失败消息长度。
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
function apiWriteError(/* 尚未发送响应头的 HTTP 输出流，函数将结束错误响应。 */ response: ServerResponse, /* 关联本次命令或请求的身份，随失败信封返回。 */ requestId: string, /* 请求执行期间捕获的异常，未知异常不得直接暴露给客户端。 */ error: unknown, /* 可选内部诊断报告器，用于保存原始故障及生成错误编号。 */ reporter?: DiagnosticReporter, /* 可选请求路径，只取有界文本作为诊断上下文。 */ route?: string): void {
  // 将领域错误写成公共失败响应，对未知异常脱敏并生成诊断编号。
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
export function apiCreateServer(
  /* 由部署入口组装的应用服务，承担身份、权限与业务事务。 */ application: ApplicationService,
  /* 可选内部令牌及诊断配置；默认空对象，令牌可回退到环境配置。 */ options: { internalToken?: string; reporter?: DiagnosticReporter } = {},
): Server & {
  // 进入停止接收新写入、领取与订阅的阶段；现有连接由后续 close 负责排空。
  beginShutdown(): void
} {
  // 组装业务、内部 Host 和文件 HTTP 入口，并提供拒绝新写入的关闭标记。
  const internalToken = options.internalToken ?? process.env.CHONGMING_DATA_TOKEN
  const service = application.graph
  const streams = new Set<ServerResponse>()
  let stopping = false
  const server = createServer(async (/* 服务器收到的原始 HTTP 请求，路由、令牌和载荷均在本层解析。 */ request, /* 当前请求的响应流，普通 JSON、附件及 SSE 共用此输出。 */ response) => {
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
        apiWriteJson(response, 200, { ok: true, data: await service.propose(input, proof) })
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
        if ([...url.searchParams.keys()].some(/* 上传 URL 的查询字段名，只允许工作区身份和文件名。 */ key => /* 拒绝上传 URL 中未声明的参数。 */  !['workspaceId', 'filename'].includes(key))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.UNKNOWN_UPLOAD_PARAMETER)
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
  server.close = /* Node HTTP Server 可选关闭回调，原样转交底层关闭实现。 */ callback => {
    // 关闭全部 SSE 响应后转交原 HTTP Server 的关闭操作。
    for (const stream of streams) stream.destroy()
    return close(callback)
  }
  return server as Server & {
    // 标记停止接收新业务，供运行入口在关闭 HTTP 服务前先降低就绪状态。
    beginShutdown(): void
  }
}
