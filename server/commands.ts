import { readFileSync } from 'node:fs'
import { AppError, ErrorCode } from '../electron/shared/errors'
import { WORKSPACE_DEFAULT_ID } from '../electron/shared/types'
import { mapperService } from '../electron/mapper'
import type {
  MapperNode,
  MapperSnapshot,
  MapperTimeline,
} from '../electron/mapper/types'
import { cliThrowUsage } from './errors'

const DATA_KINDS = new Set(['source', 'news', 'claim', 'opinion'])
const STATE_CHAIN = ['source', 'news', 'fact', 'conclusion'] as const
type StateIndex = 0 | 1 | 2 | 3
type StateKind = typeof STATE_CHAIN[number]

export function cliReadContentArg(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  if (raw.startsWith('@')) {
    return readFileSync(raw.slice(1), 'utf-8')
  }
  return raw
}

export function cliParseStateIndex(raw: string): StateIndex {
  const asNum = Number(raw)
  if (asNum === 0 || asNum === 1 || asNum === 2 || asNum === 3) {
    return asNum
  }
  const idx = STATE_CHAIN.indexOf(raw as StateKind)
  if (idx >= 0) return idx as StateIndex
  cliThrowUsage(`invalid timeline index or kind: ${raw} (use 0-3 or ${STATE_CHAIN.join('|')})`)
}

function cliReadDataNodes(snapshot: MapperSnapshot): MapperNode[] {
  return snapshot.nodes.filter(n => DATA_KINDS.has(n.kind))
}

function cliWriteOk(payload: unknown): void {
  console.log(JSON.stringify(payload))
}

async function cliAcquireMap(mapId: string): Promise<void> {
  const result = await mapperService.dispatch({ type: 'lease.acquire', mapId })
  if (result.type !== 'lease.updated' || !result.ok) {
    throw new AppError(ErrorCode.MAP_LEASE_HELD, `Map is locked: ${mapId}`)
  }
}

function cliReadNewNodeId(
  before: MapperSnapshot,
  after: MapperSnapshot,
  kind: string,
): string {
  const prev = new Set(before.nodes.map(n => n.id))
  const created = after.nodes.find(n => !prev.has(n.id) && n.kind === kind)
  if (!created) {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      `failed to locate created ${kind} node`,
    )
  }
  return created.id
}

export async function cmdList(workspaceId?: string): Promise<void> {
  const wid = workspaceId?.trim() || WORKSPACE_DEFAULT_ID
  const result = await mapperService.read({ type: 'map.list', workspaceId: wid })
  if (result.type !== 'map.list') throw new Error('map list failed')
  cliWriteOk({ ok: true, workspaceId: wid, maps: result.maps })
}

export async function cmdCreate(input: {
  kind: 'source' | 'news' | 'claim'
  mapId?: string
  workspaceId?: string
  uri?: string
  sourceKind?: 'file' | 'url'
  label?: string
  content?: string
}): Promise<void> {
  const workspaceId = input.workspaceId?.trim() || WORKSPACE_DEFAULT_ID

  let mapId = input.mapId?.trim()
  if (!mapId) {
    const created = await mapperService.dispatch({
      type: 'map.create',
      workspaceId,
    })
    if (created.type !== 'map.updated') throw new Error('map create failed')
    mapId = created.snapshot.mapId
  } else {
    await cliAcquireMap(mapId)
  }

  const read = await mapperService.read({ type: 'map.snapshot', mapId })
  if (read.type !== 'map.snapshot' || !read.snapshot) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
  const before = read.snapshot
  let after: MapperSnapshot

  if (input.kind === 'source') {
    if (!input.uri?.trim()) cliThrowUsage('create --kind source requires --uri')
    const result = await mapperService.dispatch({
      type: 'node.create',
      mapId,
      node: {
        kind: 'source',
      uri: input.uri.trim(),
        sourceKind: input.sourceKind ?? (input.uri.startsWith('http') ? 'url' : 'file'),
      label: input.label,
      },
    })
    if (result.type !== 'map.updated') throw new Error('source create failed')
    after = result.snapshot
  } else if (input.kind === 'news') {
    const result = await mapperService.dispatch({
      type: 'node.create',
      mapId,
      node: { kind: 'news', content: input.content ?? '' },
    })
    if (result.type !== 'map.updated') throw new Error('news create failed')
    after = result.snapshot
  } else {
    const result = await mapperService.dispatch({
      type: 'node.create',
      mapId,
      node: { kind: 'claim', content: input.content ?? '' },
    })
    if (result.type !== 'map.updated') throw new Error('claim create failed')
    after = result.snapshot
  }

  const nodeId = cliReadNewNodeId(before, after, input.kind)
  cliWriteOk({ ok: true, mapId, nodeId, kind: input.kind })
}

export async function cmdRun(input: {
  mapId: string
  from?: string
  to?: string
  scope?: string
}): Promise<void> {
  const mapId = input.mapId.trim()
  if (!mapId) cliThrowUsage('run requires <mapId>')
  await cliAcquireMap(mapId)

  const patch: { startX?: StateIndex, endX?: StateIndex, activeScope?: string } = {}
  if (input.from !== undefined) patch.startX = cliParseStateIndex(input.from)
  if (input.to !== undefined) patch.endX = cliParseStateIndex(input.to)
  if (input.scope !== undefined) patch.activeScope = input.scope

  if (patch.startX !== undefined || patch.endX !== undefined || patch.activeScope !== undefined) {
    const read = await mapperService.read({ type: 'map.snapshot', mapId })
    if (read.type !== 'map.snapshot' || !read.snapshot) {
      throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
    }
    const snap = read.snapshot
    const startX = patch.startX ?? snap.timeline.startX
    const endX = patch.endX ?? snap.timeline.endX
    const timeline: MapperTimeline = {
      startX,
      endX,
      activeScope: patch.activeScope ?? snap.timeline.activeScope,
    }
    if (timeline.startX > timeline.endX) {
      cliThrowUsage(`timeline startX ${timeline.startX} > endX ${timeline.endX}`)
    }
    await mapperService.dispatch({
      type: 'timeline.update',
      mapId,
      patch: {
      ...(patch.startX !== undefined ? { startX: patch.startX } : {}),
      ...(patch.endX !== undefined ? { endX: patch.endX } : {}),
      ...(patch.activeScope !== undefined ? { activeScope: patch.activeScope } : {}),
      },
    })
  }

  const result = await mapperService.dispatch({
    type: 'run.start',
    mapId,
    mode: 'auto',
    selectedNodeId: input.scope,
  })
  if (result.type !== 'map.updated') throw new Error('run failed')
  const snapshot = result.snapshot
  cliWriteOk({
    ok: true,
    mapId,
    status: 'done',
    from: snapshot.timeline.startX,
    to: snapshot.timeline.endX,
    nodes: cliReadDataNodes(snapshot).map(n => ({
      id: n.id,
      kind: n.kind,
      params: n.params,
      ...(n.parentId ? { parentId: n.parentId } : {}),
    })),
  })
}

export async function cmdStatus(mapId: string): Promise<void> {
  const id = mapId.trim()
  if (!id) cliThrowUsage('status requires <mapId>')
  const result = await mapperService.read({ type: 'map.snapshot', mapId: id })
  if (result.type !== 'map.snapshot' || !result.snapshot) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${id}`)
  }
  const snapshot = result.snapshot
  cliWriteOk({
    ok: true,
    mapId: id,
    runPhase: snapshot.runPhase,
    from: snapshot.timeline.startX,
    to: snapshot.timeline.endX,
    nodes: cliReadDataNodes(snapshot).map(n => ({
      id: n.id,
      kind: n.kind,
      params: n.params,
      ...(n.parentId ? { parentId: n.parentId } : {}),
    })),
  })
}
