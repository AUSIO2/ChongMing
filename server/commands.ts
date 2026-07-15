import { readFileSync } from 'node:fs'
import { AppError, ErrorCode } from '../electron/shared/errors'
import { WORKSPACE_DEFAULT_ID } from '../electron/shared/types'
import { portReadApi } from '../src/flow-map/port'
import {
  STATE_CHAIN,
  timelineValidate,
  type StateIndex,
  type StateKind,
} from '../src/flow-map/timeline'
import type { MapNode, MapSnapshot } from '../src/flow-map/types'
import { serverReadElectronApi } from './bootstrap'
import { cliThrowUsage } from './errors'

const DATA_KINDS = new Set(['source', 'news', 'claim', 'opinion'])

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

function cliReadDataNodes(snapshot: MapSnapshot): MapNode[] {
  return snapshot.nodes.filter(n => DATA_KINDS.has(n.kind))
}

function cliWriteOk(payload: unknown): void {
  console.log(JSON.stringify(payload))
}

function cliReadNewNodeId(
  before: MapSnapshot,
  after: MapSnapshot,
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
  const maps = await serverReadElectronApi().map.list(wid)
  cliWriteOk({ ok: true, workspaceId: wid, maps })
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
  const api = portReadApi()
  const workspaceId = input.workspaceId?.trim() || WORKSPACE_DEFAULT_ID

  let mapId = input.mapId?.trim()
  if (!mapId) {
    const map = await serverReadElectronApi().map.create({ workspaceId })
    mapId = map._id
  }

  const before = await api.getSnapshot(mapId)
  let after: MapSnapshot

  if (input.kind === 'source') {
    if (!input.uri?.trim()) cliThrowUsage('create --kind source requires --uri')
    after = await api.addSourceChain(mapId, {
      uri: input.uri.trim(),
      kind: input.sourceKind ?? (input.uri.startsWith('http') ? 'url' : 'file'),
      label: input.label,
    })
  } else if (input.kind === 'news') {
    after = await api.addRootNews(mapId, input.content ?? '')
  } else {
    after = await api.addRootClaim(mapId, input.content ?? '')
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
  const api = portReadApi()
  const mapId = input.mapId.trim()
  if (!mapId) cliThrowUsage('run requires <mapId>')

  const patch: { startX?: StateIndex, endX?: StateIndex, activeScope?: string } = {}
  if (input.from !== undefined) patch.startX = cliParseStateIndex(input.from)
  if (input.to !== undefined) patch.endX = cliParseStateIndex(input.to)
  if (input.scope !== undefined) patch.activeScope = input.scope

  if (patch.startX !== undefined || patch.endX !== undefined || patch.activeScope !== undefined) {
    const snap = await api.getSnapshot(mapId)
    const startX = patch.startX ?? snap.timeline.startX
    const endX = patch.endX ?? snap.timeline.endX
    timelineValidate({
      startX,
      endX,
      activeScope: patch.activeScope ?? snap.timeline.activeScope,
    })
    await api.updateTimeline(mapId, {
      ...(patch.startX !== undefined ? { startX: patch.startX } : {}),
      ...(patch.endX !== undefined ? { endX: patch.endX } : {}),
      ...(patch.activeScope !== undefined ? { activeScope: patch.activeScope } : {}),
    })
  }

  const result = await api.runTimeline(mapId, 'auto', input.scope ?? null)
  if (result.status !== 'done') {
    throw new AppError(
      ErrorCode.CLI_RUN_INTERRUPTED,
      `runTimeline stopped with status=${result.status}`,
    )
  }

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
  const snapshot = await portReadApi().getSnapshot(id)
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
