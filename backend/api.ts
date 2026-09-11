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
} from '../contracts/graph'
import type { ControlCommand, ControlQuery } from '../contracts/control'
import { GraphError } from './graph-error'
import { graphInputReadNodeData } from './graph-input'
import type { ApplicationService } from './application'
import { controlReadCommand, controlReadQuery } from './control'
import { configurationReadSlots } from './configuration'
import {
  inputReadObject as apiReadObject, inputReadString as apiReadString, inputReadId as apiReadId,
  inputReadRevision as apiReadRevision, inputReadArray as apiReadArray,
  inputReadNames as apiReadNames, inputReadScore as apiReadScore, inputReadIds as apiReadIds,
} from './input'

const MAX_BODY_BYTES = 1_048_576

function apiWriteJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function apiReadBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new GraphError(413, 'PAYLOAD_TOO_LARGE', 'Body exceeds 1 MiB')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new GraphError(400, 'INVALID_JSON', 'Body must be valid JSON')
  }
}

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
        if (kind !== 'mentions' && kind !== 'verifies' && kind !== 'related-to') {
          throw new GraphError(400, 'INVALID_ARGUMENT', 'edge.kind is invalid')
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
      ['mapId', 'expectedRevision', 'id', 'targetId', 'mode'],
      'params',
    )
    if (params.mode !== 'auto' && params.mode !== 'human-in-loop') {
      throw new GraphError(400, 'INVALID_ARGUMENT', 'params.mode is invalid')
    }
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        expectedRevision: apiReadRevision(params.expectedRevision, 'params.expectedRevision'),
        id: apiReadId(params.id, 'params.id'),
        targetId: apiReadId(params.targetId, 'params.targetId'),
        mode: params.mode,
      },
    }
  }
  if (envelope.method === 'run.cancel') {
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
      ['mapId', 'expectedRevision', 'runId', 'reviewId', 'expectedReviewRevision', 'reason', 'slots'], 'params')
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        expectedRevision: apiReadRevision(params.expectedRevision, 'params.expectedRevision'),
        runId: apiReadId(params.runId, 'params.runId'),
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
      ['mapId', 'expectedRevision', 'runId', 'reviewId', 'expectedReviewRevision', 'decision'],
      'params',
    )
    if (params.decision !== 'approve' && params.decision !== 'reject') {
      throw new GraphError(400, 'INVALID_ARGUMENT', 'params.decision is invalid')
    }
    return {
      requestId,
      method: envelope.method,
      params: {
        mapId: apiReadId(params.mapId, 'params.mapId'),
        expectedRevision: apiReadRevision(params.expectedRevision, 'params.expectedRevision'),
        runId: apiReadId(params.runId, 'params.runId'),
        reviewId: apiReadId(params.reviewId, 'params.reviewId'),
        expectedReviewRevision: apiReadRevision(
          params.expectedReviewRevision,
          'params.expectedReviewRevision',
        ),
        decision: params.decision,
      },
    }
  }
  if (envelope.method === 'asset.delete') {
    const params = apiReadObject(envelope.params, ['assetId', 'expectedSha256'], 'params')
    return { requestId, method: 'asset.delete', params: {
      assetId: apiReadId(params.assetId, 'assetId'), expectedSha256: apiReadString(params.expectedSha256, 'expectedSha256'),
    } }
  }
  if (envelope.method === 'workspace.import') {
    const params = apiReadObject(envelope.params, ['id', 'bundleAssetId', 'stagingWorkspaceId', 'name'], 'params')
    if (params.name !== null && typeof params.name !== 'string') throw new GraphError(400, 'INVALID_ARGUMENT', 'name must be string or null')
    return { requestId, method: 'workspace.import', params: {
      id: apiReadId(params.id, 'id'), bundleAssetId: apiReadId(params.bundleAssetId, 'bundleAssetId'),
      stagingWorkspaceId: apiReadId(params.stagingWorkspaceId, 'stagingWorkspaceId'), name: params.name,
    } }
  }
  return controlReadCommand(value)
}

function apiReadDataQuery(value: unknown): { mapId: string; operationId: string } {
  const input = apiReadObject(value, ['mapId', 'operationId'], 'data.read')
  return {
    mapId: apiReadId(input.mapId, 'mapId'),
    operationId: apiReadString(input.operationId, 'operationId'),
  }
}

function apiReadDataProposal(value: unknown): GraphDataProposal {
  const input = apiReadObject(value,
    ['mapId', 'operationId', 'id', 'kind', 'reason', 'slots', 'routeRevision', 'slotId', 'score', 'reportIds'], 'data.propose')
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
  const routeRevision = apiReadRevision(input.routeRevision, 'routeRevision')
  const score = apiReadScore(input.score)
  if (input.kind === 'report') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'kind', 'reason', 'routeRevision', 'slotId', 'score'], 'report')
    return { ...base, kind: 'report', routeRevision, score, slotId: apiReadString(input.slotId, 'slotId') }
  }
  if (input.kind === 'merge') {
    apiReadObject(value, ['mapId', 'operationId', 'id', 'kind', 'reason', 'routeRevision', 'reportIds', 'score'], 'merge')
    return { ...base, kind: 'merge', routeRevision, score, reportIds: apiReadNames(input.reportIds, 'reportIds') }
  }
  throw new GraphError(400, 'INVALID_ARGUMENT', 'proposal.kind is invalid')
}

function apiValidateToken(request: IncomingMessage, token: string | undefined): void {
  const supplied = request.headers.authorization
  const expected = token ? `Bearer ${token}` : ''
  if (!expected || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new GraphError(401, 'UNAUTHORIZED', 'Internal API requires a configured Host token')
  }
}

function apiReadUserToken(request: IncomingMessage): string {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw new GraphError(401, 'UNAUTHORIZED', 'A user token is required')
  return header.slice(7)
}

function apiReadProof(input: Record<string, unknown>): GraphWorkProof {
  const workId = apiReadString(input.workId, 'workId')
  if (!/^[a-zA-Z0-9_:-]{1,256}$/.test(workId)) throw new GraphError(400, 'INVALID_ARGUMENT', 'workId is invalid')
  const fence = apiReadRevision(input.fence, 'fence')
  if (fence < 1) throw new GraphError(400, 'INVALID_ARGUMENT', 'fence must be positive')
  return { workId, holderId: apiReadId(input.holderId, 'holderId'), fence }
}

function apiReadWorkProof(request: IncomingMessage): GraphWorkProof {
  const fence = request.headers['x-work-fence']
  if (typeof fence !== 'string' || !/^[1-9][0-9]*$/.test(fence)) throw new GraphError(400, 'INVALID_ARGUMENT', 'x-work-fence is required')
  return apiReadProof({ workId: request.headers['x-work-id'], holderId: request.headers['x-work-holder'], fence: Number(fence) })
}

function apiReadWorkCommand(value: unknown): GraphWorkCommand {
  const input = apiReadObject(value, ['method', 'params'], 'work')
  if (input.method === 'claim') {
    const params = apiReadObject(input.params, ['hostId', 'holderId', 'mapId'], 'params')
    const hostId = apiReadString(params.hostId, 'hostId')
    if (hostId.length > 128) throw new GraphError(400, 'INVALID_ARGUMENT', 'hostId exceeds 128 characters')
    return { method: 'claim', params: { hostId, holderId: apiReadId(params.holderId, 'holderId'),
      ...(params.mapId === undefined ? {} : { mapId: apiReadId(params.mapId, 'mapId') }),
    } }
  }
  if (input.method !== 'read' && input.method !== 'renew' && input.method !== 'release' && input.method !== 'fail') {
    throw new GraphError(400, 'UNKNOWN_METHOD', 'Unknown work method')
  }
  const params = apiReadObject(input.params,
    ['mapId', 'workId', 'holderId', 'fence', ...(input.method === 'fail' ? ['message'] : [])], 'params')
  const proof = { mapId: apiReadId(params.mapId, 'mapId'), ...apiReadProof(params) }
  if (input.method === 'fail') {
    const message = apiReadString(params.message, 'message')
    if (message.length > 1000) throw new GraphError(400, 'INVALID_ARGUMENT', 'message exceeds 1000 characters')
    return { method: 'fail', params: { ...proof, message } }
  }
  return { method: input.method, params: proof }
}

function apiWriteError(response: ServerResponse, requestId: string, error: unknown): void {
  const graphError = error instanceof GraphError
    ? error
    : new GraphError(500, 'INTERNAL_ERROR', 'Internal server error')
  const body: GraphFailure = {
    ok: false,
    requestId,
    error: {
      code: graphError.code,
      message: graphError.message,
      retryable: graphError.status >= 500,
      ...(graphError.currentRevision === undefined ? {} : { currentRevision: graphError.currentRevision }),
    },
  }
  apiWriteJson(response, graphError.status, body)
}

export function apiCreateServer(
  application: ApplicationService,
  options: { internalToken?: string } = {},
): Server {
  const internalToken = options.internalToken ?? process.env.CHONGMING_DATA_TOKEN
  const service = application.graph
  return createServer(async (request, response) => {
    let requestId: string = randomUUID()
    try {
      if (request.method === 'GET' && request.url === '/health') {
        apiWriteJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && request.url === '/internal/v1/data/read') {
        apiValidateToken(request, internalToken)
        const proof = apiReadWorkProof(request)
        const input = apiReadDataQuery(await apiReadBody(request))
        apiWriteJson(response, 200, { ok: true, data: await service.readData(input.mapId, input.operationId, proof) })
        return
      }
      if (request.method === 'POST' && request.url === '/internal/v1/data/propose') {
        apiValidateToken(request, internalToken)
        const proof = apiReadWorkProof(request)
        const input = apiReadDataProposal(await apiReadBody(request))
        apiWriteJson(response, 200, { ok: true, data: await service.propose(input, proof) })
        return
      }
      if (request.method === 'POST' && request.url === '/internal/v1/work') {
        apiValidateToken(request, internalToken)
        const command = apiReadWorkCommand(await apiReadBody(request))
        apiWriteJson(response, 200, { ok: true, data: await service.dispatchWork(command) })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'POST' && url.pathname === '/api/v1/assets') {
        const token = apiReadUserToken(request)
        if ([...url.searchParams.keys()].some(key => !['workspaceId', 'filename'].includes(key))) throw new GraphError(400, 'INVALID_ARGUMENT', 'Unknown upload parameter')
        const length = request.headers['content-length']
        if (typeof length !== 'string' || !/^[0-9]+$/.test(length)) throw new GraphError(400, 'INVALID_ARGUMENT', 'Content-Length is required')
        const size = Number(length)
        if (!Number.isSafeInteger(size)) throw new GraphError(413, 'PAYLOAD_TOO_LARGE', 'Asset is too large')
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
        throw new GraphError(404, 'NOT_FOUND', 'Not found')
      }
      const token = apiReadUserToken(request)
      const body = await apiReadBody(request)
      if (request.url === '/api/v1/query') {
        const data = await application.read(token, apiReadQuery(body))
        const result: GraphSuccess<typeof data> = { ok: true, requestId, replayed: false, data }
        apiWriteJson(response, 200, result)
        return
      }
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
      if (response.headersSent) response.destroy(error instanceof Error ? error : undefined)
      else apiWriteError(response, requestId, error)
    }
  })
}
