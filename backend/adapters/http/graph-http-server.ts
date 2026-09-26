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

// 用途：处理API 请求相关工作，并把结果交给调用方。
function apiWriteJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

// 用途：读取请求体，并把结构化结果交给调用方。
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

// 用途：读取变更，并把结构化结果交给调用方。
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
        const item = apiReadObject(value, ['id', 'data'], `params.changes.nodes.put[${index}]`)
        return { id: apiReadId(item.id, 'node.id'), data: graphInputReadNodeData(item.data, 'node.data') }
      }),
      remove: nodes.remove === undefined ? undefined : apiReadIds(nodes.remove, 'params.changes.nodes.remove'),
    },
    edges: edges && {
      put: edges.put === undefined ? undefined : apiReadArray(edges.put, 'params.changes.edges.put').map((value, index) => {
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

// 用途：读取查询，并把结构化结果交给调用方。
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

// 用途：读取命令，并把结构化结果交给调用方。
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

// 用途：读取布尔值，并把结构化结果交给调用方。
function apiReadBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_BOOLEAN, label))
  return value
}
// 用途：读取API 请求，并把结构化结果交给调用方。
function apiReadUntil(value: unknown): 'news' | 'claims' | 'verified' {
  if (value !== 'news' && value !== 'claims' && value !== 'verified') throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.UNTIL_MUST_BE_NEWS_CLAIMS_OR_VERIFIED)
  return value
}
// 用途：读取API 请求，并把结构化结果交给调用方。
function apiReadOutputs(value: unknown, kind: 'news'): import('../../../contracts/graph').GraphNewsOutput[]
// 用途：读取API 请求，并把结构化结果交给调用方。
function apiReadOutputs(value: unknown, kind: 'claim'): import('../../../contracts/graph').GraphClaimOutput[]
// 用途：读取API 请求，并把结构化结果交给调用方。
function apiReadOutputs(value: unknown, kind: 'news' | 'claim') {
  const items = apiReadArray(value, kind)
  if (items.length > 256) throw new GraphError(413, 'OUTPUT_LIMIT', RuntimeMessage.AT_MOST_256_OUTPUTS_PER_OPERATION)
  return items.map(value => {
    const item = apiReadObject(value, kind === 'news' ? ['content', 'context'] : ['content', 'category'], kind)
    const node = graphInputReadNodeData({ ...item, kind }, kind)
    if (node.kind === 'news') return { content: node.content, context: node.context }
    if (node.kind === 'claim') return { content: node.content, category: node.category }
    throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_OUTPUT_KIND)
  })
}

// 用途：读取数据提案，并把结构化结果交给调用方。
function apiReadDataProposal(value: unknown): GraphDataProposal {
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
    const selected = apiReadArray(input.selected, 'selected').map(value => {
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

// 用途：校验令牌输入，发现不符合约束时立即报错。
function apiValidateToken(request: IncomingMessage, token: string | undefined): void {
  const supplied = request.headers.authorization
  const expected = token ? `Bearer ${token}` : ''
  if (!expected || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new GraphError(401, 'UNAUTHORIZED', RuntimeMessage.INTERNAL_API_REQUIRES_A_CONFIGURED_HOST_TOKEN)
  }
}

// 用途：读取用户令牌，并把结构化结果交给调用方。
function apiReadUserToken(request: IncomingMessage): string {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw new GraphError(401, 'UNAUTHORIZED', RuntimeMessage.A_USER_TOKEN_IS_REQUIRED)
  return header.slice(7)
}

// 用途：读取工作标识，并把结构化结果交给调用方。
function apiReadWorkId(value: unknown): string {
  const workId = apiReadString(value, 'workId')
  if (!/^[a-zA-Z0-9_:-]{1,256}$/.test(workId)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.WORKID_IS_INVALID)
  return workId
}

// 用途：读取凭证，并把结构化结果交给调用方。
function apiReadProof(input: Record<string, unknown>): GraphWorkProof {
  const workId = apiReadWorkId(input.workId)
  const fence = apiReadRevision(input.fence, 'fence')
  if (fence < 1) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.FENCE_MUST_BE_POSITIVE)
  return { workId, holderId: apiReadId(input.holderId, 'holderId'), fence }
}

// 用途：读取工作凭证，并把结构化结果交给调用方。
function apiReadWorkProof(request: IncomingMessage): GraphWorkProof {
  const fence = request.headers['x-work-fence']
  if (typeof fence !== 'string' || !/^[1-9][0-9]*$/.test(fence)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.X_WORK_FENCE_IS_REQUIRED)
  return apiReadProof({ workId: request.headers['x-work-id'], holderId: request.headers['x-work-holder'], fence: Number(fence) })
}

// 用途：读取工作命令，并把结构化结果交给调用方。
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

// 用途：处理API 请求相关工作，并把结果交给调用方。
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

// 用途：创建API 请求，供后续流程使用。
export function apiCreateServer(
  application: ApplicationService,
  options: { internalToken?: string; reporter?: DiagnosticReporter } = {},
): Server & { beginShutdown(): void } {
  const internalToken = options.internalToken ?? process.env.CHONGMING_DATA_TOKEN
  const service = application.graph
  const streams = new Set<ServerResponse>()
  let stopping = false
  const server = createServer(async (request, response) => {
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
        if ([...url.searchParams.keys()].some(key => !['workspaceId', 'filename'].includes(key))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.UNKNOWN_UPLOAD_PARAMETER)
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
  Object.assign(server, { // 用途：处理当前模块相关的Shutdown。
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    beginShutdown() { stopping = true } })
  server.close = callback => {
    for (const stream of streams) stream.destroy()
    return close(callback)
  }
  return server as Server & { beginShutdown(): void }
}
