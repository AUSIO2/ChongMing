import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type {
  GraphChanges,
  GraphCommand,
  GraphFailure,
  GraphNodeData,
  GraphQuery,
  GraphSuccess,
} from '../contracts/graph'
import { DEVELOPMENT_WORKSPACE_ID } from '../contracts/graph'
import { GraphError } from './graph-error'
import type { GraphService } from './graph'

const MAX_BODY_BYTES = 1_048_576
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

function apiReadObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be an object`)
  }
  const object = value as Record<string, unknown>
  const unknown = Object.keys(object).find(key => !keys.includes(key))
  if (unknown) throw new GraphError(400, 'INVALID_ARGUMENT', `${label}.${unknown} is not allowed`)
  return object
}

function apiReadString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be a non-empty string`)
  }
  return value
}

function apiReadId(value: unknown, label: string): string {
  const id = apiReadString(value, label)
  if (!UUID.test(id)) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be a UUID`)
  return id
}

function apiReadRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be a non-negative integer`)
  }
  return value as number
}

function apiReadStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be an array`)
  return value.map((item, index) => apiReadId(item, `${label}[${index}]`))
}

function apiReadArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be an array`)
  return value
}

function apiReadNodeData(value: unknown, label: string): GraphNodeData {
  const base = apiReadObject(value, ['kind', 'content', 'context', 'category'], label)
  const content = apiReadString(base.content, `${label}.content`)
  if (base.kind === 'claim') {
    if (base.context !== undefined) throw new GraphError(400, 'INVALID_ARGUMENT', `${label}.context is not allowed`)
    if (base.category !== null && base.category !== undefined && typeof base.category !== 'string') {
      throw new GraphError(400, 'INVALID_ARGUMENT', `${label}.category must be a string or null`)
    }
    return { kind: 'claim' as const, content, category: (base.category as string | null) ?? null }
  }
  if (base.kind !== 'news') throw new GraphError(400, 'INVALID_ARGUMENT', `${label}.kind is invalid`)
  if (base.category !== undefined) throw new GraphError(400, 'INVALID_ARGUMENT', `${label}.category is not allowed`)
  if (!base.context || typeof base.context !== 'object' || Array.isArray(base.context)) {
    throw new GraphError(400, 'INVALID_ARGUMENT', `${label}.context must be an object`)
  }
  const rawContext = base.context as Record<string, unknown>
  const context = Object.fromEntries(Object.entries(rawContext).map(([key, item]) => {
    const field = apiReadObject(item, ['value', 'visibleToAI'], `${label}.context.${key}`)
    if (typeof field.value !== 'string' || typeof field.visibleToAI !== 'boolean') {
      throw new GraphError(400, 'INVALID_ARGUMENT', `${label}.context.${key} is invalid`)
    }
    return [key, { value: field.value, visibleToAI: field.visibleToAI }]
  }))
  return { kind: 'news' as const, content, context }
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
        return { id: apiReadId(item.id, 'node.id'), data: apiReadNodeData(item.data, 'node.data') }
      }),
      remove: nodes.remove === undefined ? undefined : apiReadStrings(nodes.remove, 'params.changes.nodes.remove'),
    },
    edges: edges && {
      put: edges.put === undefined ? undefined : apiReadArray(edges.put, 'params.changes.edges.put').map((value, index) => {
        const item = apiReadObject(value, ['id', 'kind', 'from', 'to'], `params.changes.edges.put[${index}]`)
        const kind = item.kind
        if (kind !== 'mentions' && kind !== 'related-to') {
          throw new GraphError(400, 'INVALID_ARGUMENT', 'edge.kind is invalid')
        }
        return {
          id: apiReadId(item.id, 'edge.id'),
          kind,
          from: apiReadId(item.from, 'edge.from'),
          to: apiReadId(item.to, 'edge.to'),
        }
      }),
      remove: edges.remove === undefined ? undefined : apiReadStrings(edges.remove, 'params.changes.edges.remove'),
    },
  }
}

function apiReadQuery(value: unknown): GraphQuery {
  const envelope = apiReadObject(value, ['method', 'params'], 'query')
  if (envelope.method === 'map.list') {
    const params = apiReadObject(envelope.params, ['workspaceId'], 'params')
    const workspaceId = apiReadString(params.workspaceId, 'params.workspaceId')
    if (workspaceId !== DEVELOPMENT_WORKSPACE_ID) {
      throw new GraphError(404, 'WORKSPACE_NOT_FOUND', `Workspace not found: ${workspaceId}`)
    }
    return { method: envelope.method, params: { workspaceId } }
  }
  if (envelope.method === 'map.get') {
    const params = apiReadObject(envelope.params, ['mapId'], 'params')
    return { method: envelope.method, params: { mapId: apiReadId(params.mapId, 'params.mapId') } }
  }
  throw new GraphError(400, 'UNKNOWN_METHOD', `Unknown query method: ${String(envelope.method)}`)
}

function apiReadCommand(value: unknown): GraphCommand {
  const envelope = apiReadObject(value, ['requestId', 'method', 'params'], 'command')
  const requestId = apiReadId(envelope.requestId, 'requestId')
  if (envelope.method === 'map.create') {
    const params = apiReadObject(envelope.params, ['workspaceId', 'expectedRevision', 'id', 'name'], 'params')
    const workspaceId = apiReadString(params.workspaceId, 'params.workspaceId')
    if (workspaceId !== DEVELOPMENT_WORKSPACE_ID) {
      throw new GraphError(404, 'WORKSPACE_NOT_FOUND', `Workspace not found: ${workspaceId}`)
    }
    const revision = apiReadRevision(params.expectedRevision, 'params.expectedRevision')
    if (revision !== 0) throw new GraphError(409, 'REVISION_CONFLICT', 'Development Workspace revision is 0', 0)
    return {
      requestId,
      method: envelope.method,
      params: {
        workspaceId,
        expectedRevision: 0,
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
  throw new GraphError(400, 'UNKNOWN_METHOD', `Unknown command method: ${String(envelope.method)}`)
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

export function apiCreateServer(service: GraphService): Server {
  return createServer(async (request, response) => {
    let requestId: string = randomUUID()
    try {
      if (request.method === 'GET' && request.url === '/health') {
        apiWriteJson(response, 200, { ok: true })
        return
      }
      if (request.method !== 'POST' || !['/api/v1/query', '/api/v1/command'].includes(request.url ?? '')) {
        throw new GraphError(404, 'NOT_FOUND', 'Not found')
      }
      const body = await apiReadBody(request)
      if (request.url === '/api/v1/query') {
        const data = await service.read(apiReadQuery(body))
        const result: GraphSuccess<typeof data> = { ok: true, requestId, replayed: false, data }
        apiWriteJson(response, 200, result)
        return
      }
      const command = apiReadCommand(body)
      requestId = command.requestId
      const result = await service.dispatch(command)
      const bodyResult: GraphSuccess<typeof result.data> = {
        ok: true,
        requestId,
        replayed: result.replayed,
        data: result.data,
      }
      apiWriteJson(response, command.method === 'map.create' && !result.replayed ? 201 : 200, bodyResult)
    } catch (error) {
      apiWriteError(response, requestId, error)
    }
  })
}
