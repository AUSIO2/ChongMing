/** 工作区 CRUD — agents 内嵌；maps 经 workspaceId 归属 */

import { randomUUID } from 'node:crypto'
import { MapModel, WorkspaceModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import type { AgentDoc } from '../shared/types'
import { WORKSPACE_DEFAULT_ID } from '../shared/types'
import {
  localAgentList,
  localAgentReadFromDisk,
  localAgentSeedFromDisk,
} from './local-agent-service'
import type {
  CreateWorkspaceInput,
  DisplayWorkspace,
  DisplayWorkspaceSummary,
  UpdateWorkspaceInput,
  UploadLocalAgentsMode,
} from './types'

function workspaceToDisplay(doc: Record<string, unknown>): DisplayWorkspace {
  const agentsRaw = (doc.agents as AgentDoc[] | undefined) ?? []
  const agents = agentsRaw.map(a => ({
    ...a,
    updatedAt: a.updatedAt instanceof Date
      ? a.updatedAt.toISOString()
      : a.updatedAt,
  }))
  const ui = doc.ui as DisplayWorkspace['ui'] | undefined
  return {
    _id: String(doc._id),
    name: String(doc.name ?? ''),
    description: typeof doc.description === 'string' ? doc.description : undefined,
    agents,
    ui,
    createdAt: doc.createdAt instanceof Date
      ? doc.createdAt.toISOString()
      : new Date().toISOString(),
    updatedAt: doc.updatedAt instanceof Date
      ? doc.updatedAt.toISOString()
      : new Date().toISOString(),
  }
}

function workspaceToSummary(
  doc: Record<string, unknown>,
  mapCount: number,
): DisplayWorkspaceSummary {
  const agents = doc.agents as unknown[] | undefined
  return {
    _id: String(doc._id),
    name: String(doc.name ?? ''),
    description: typeof doc.description === 'string' ? doc.description : undefined,
    agentCount: agents?.length ?? 0,
    mapCount,
    updatedAt: doc.updatedAt instanceof Date
      ? doc.updatedAt.toISOString()
      : new Date().toISOString(),
  }
}

export async function workspaceEnsureDefault(): Promise<DisplayWorkspace> {
  let doc = await WorkspaceModel.findById(WORKSPACE_DEFAULT_ID)
  if (!doc) {
    let agents = await localAgentList()
    if (agents.length === 0) {
      agents = localAgentReadFromDisk()
    }
    doc = await WorkspaceModel.create({
      _id: WORKSPACE_DEFAULT_ID,
      name: '默认工作区',
      agents,
    })
    console.log('[workspace] 已创建默认工作区')
  }
  return workspaceToDisplay(
    (doc.toObject ? doc.toObject() : doc) as Record<string, unknown>,
  )
}

/** 无 workspaceId 的 Map 归入默认工作区。 */
export async function workspaceMigrateOrphanMaps(): Promise<number> {
  await workspaceEnsureDefault()
  const result = await MapModel.updateMany(
    {
      $or: [
        { workspaceId: { $exists: false } },
        { workspaceId: null },
        { workspaceId: '' },
      ],
    },
    { $set: { workspaceId: WORKSPACE_DEFAULT_ID } },
  )
  if (result.modifiedCount > 0) {
    console.log(`[workspace] 已归属 ${result.modifiedCount} 条孤儿 Map → 默认工作区`)
  }
  return result.modifiedCount
}

/** 连接后：种子本地 Agent → 确保默认工作区 → 迁移孤儿 Map */
export async function workspaceBootstrapAfterConnect(): Promise<void> {
  await localAgentSeedFromDisk()
  await workspaceEnsureDefault()
  await workspaceMigrateOrphanMaps()
}

export async function workspaceList(): Promise<DisplayWorkspaceSummary[]> {
  const docs = await WorkspaceModel.find().sort({ updatedAt: -1 }).lean()
  const counts = await MapModel.aggregate<{ _id: string, count: number }>([
    { $group: { _id: '$workspaceId', count: { $sum: 1 } } },
  ])
  const byWorkspace = new Map(counts.map(row => [String(row._id), row.count]))
  return docs.map(d => workspaceToSummary(
    d as Record<string, unknown>,
    byWorkspace.get(String(d._id)) ?? 0,
  ))
}

export async function workspaceGet(workspaceId: string): Promise<DisplayWorkspace | null> {
  const doc = await WorkspaceModel.findById(workspaceId).lean()
  if (!doc) return null
  return workspaceToDisplay(doc as Record<string, unknown>)
}

export async function workspaceCreate(
  input: CreateWorkspaceInput,
): Promise<DisplayWorkspace> {
  const _id = input._id ?? randomUUID()
  let agents: AgentDoc[] = input.agents ?? []
  if (input.copyLocalAgents) {
    const local = await localAgentList()
    agents = local.length > 0 ? local : localAgentReadFromDisk()
  }
  const doc = await WorkspaceModel.create({
    _id,
    name: input.name.trim() || '未命名工作区',
    description: input.description?.trim() || undefined,
    agents,
  })
  return workspaceToDisplay(doc.toObject() as Record<string, unknown>)
}

export async function workspaceUpdate(
  workspaceId: string,
  patch: UpdateWorkspaceInput,
): Promise<DisplayWorkspace> {
  const doc = await WorkspaceModel.findById(workspaceId)
  if (!doc) {
    throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, `Workspace not found: ${workspaceId}`)
  }
  if (patch.name !== undefined) {
    doc.name = patch.name.trim() || doc.name
  }
  if (patch.description !== undefined) {
    doc.description = patch.description.trim() || undefined
  }
  if (patch.agents !== undefined) {
    doc.agents = patch.agents as typeof doc.agents
    doc.markModified('agents')
  }
  if (patch.ui !== undefined) {
    doc.ui = patch.ui as typeof doc.ui
    doc.markModified('ui')
  }
  await doc.save()
  return workspaceToDisplay(doc.toObject() as Record<string, unknown>)
}

export async function workspaceDelete(workspaceId: string): Promise<void> {
  if (workspaceId === WORKSPACE_DEFAULT_ID) {
    throw new AppError(
      ErrorCode.WORKSPACE_REQUIRED,
      '不能删除默认工作区',
    )
  }
  const doc = await WorkspaceModel.findById(workspaceId)
  if (!doc) {
    throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, `Workspace not found: ${workspaceId}`)
  }
  await MapModel.deleteMany({ workspaceId })
  await WorkspaceModel.deleteOne({ _id: workspaceId })
}

export async function workspaceUploadLocalAgents(
  workspaceId: string,
  mode: UploadLocalAgentsMode = 'merge',
): Promise<DisplayWorkspace> {
  const doc = await WorkspaceModel.findById(workspaceId)
  if (!doc) {
    throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, `Workspace not found: ${workspaceId}`)
  }

  let local = await localAgentList()
  if (local.length === 0) {
    await localAgentSeedFromDisk()
    local = await localAgentList()
  }
  if (local.length === 0) {
    local = localAgentReadFromDisk()
  }

  const now = new Date()
  if (mode === 'replace') {
    doc.agents = local as typeof doc.agents
  } else {
    const byPath = new Map(
      (doc.agents ?? []).map(a => [a.promptPath, a]),
    )
    for (const agent of local) {
      byPath.set(agent.promptPath, agent as typeof doc.agents[0])
    }
    doc.agents = Array.from(byPath.values()) as typeof doc.agents
  }

  doc.agentSources = local.map(a => ({
    promptPath: a.promptPath,
    copiedFrom: 'local' as const,
    localUpdatedAt: a.updatedAt
      ? new Date(a.updatedAt)
      : undefined,
    uploadedAt: now,
  })) as typeof doc.agentSources
  doc.markModified('agents')
  doc.markModified('agentSources')
  await doc.save()
  return workspaceToDisplay(doc.toObject() as Record<string, unknown>)
}

export async function workspaceReadForMap(mapId: string): Promise<DisplayWorkspace> {
  const map = await MapModel.findById(mapId).select('workspaceId').lean()
  if (!map) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
  const workspaceId = (map as { workspaceId?: string }).workspaceId || WORKSPACE_DEFAULT_ID
  const ws = await workspaceGet(workspaceId)
  if (!ws) {
    throw new AppError(
      ErrorCode.WORKSPACE_NOT_FOUND,
      `Workspace not found: ${workspaceId}`,
    )
  }
  return ws
}

export { WORKSPACE_DEFAULT_ID }
