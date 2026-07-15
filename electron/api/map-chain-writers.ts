import { MapModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import {
  mapScopeReadKey,
  type MapChainClaims,
  type MapChainScope,
} from '../shared/map-scope'
import { mapAssertWritable } from './map-lease'

function mapChainAssertPathKey(scopeId: string): string {
  const key = mapScopeReadKey(scopeId)
  if (key.includes('.')) {
    throw new AppError(
      ErrorCode.MAP_SCOPE_NOT_FOUND,
      `Map scope id must not contain '.': ${scopeId}`,
    )
  }
  return key
}

function mapChainReadLeanScope(
  lean: { chains?: unknown } | null,
  key: string,
): MapChainScope | undefined {
  if (!lean?.chains) return undefined
  const raw = lean.chains
  if (raw instanceof Map) {
    return raw.get(key) as MapChainScope | undefined
  }
  return (raw as Record<string, MapChainScope>)[key]
}

/** 只读某个 scope（lean），不存在返回 undefined。 */
export async function mapChainReadScope(
  mapId: string,
  scopeId: string,
): Promise<MapChainScope | undefined> {
  const key = mapChainAssertPathKey(scopeId)
  const exists = await MapModel.exists({ _id: mapId })
  if (!exists) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
  const lean = await MapModel.findById(mapId)
    .select({ [`chains.${key}`]: 1 })
    .lean()
  return mapChainReadLeanScope(lean, key)
}

/** 要求 scope 存在，否则 MAP_SCOPE_NOT_FOUND。 */
export async function mapChainRequireScope(
  mapId: string,
  scopeId: string,
): Promise<MapChainScope> {
  const scope = await mapChainReadScope(mapId, scopeId)
  if (!scope) {
    throw new AppError(
      ErrorCode.MAP_SCOPE_NOT_FOUND,
      `Map scope not found: ${scopeId}`,
    )
  }
  return scope
}

/** split 按条：只 $set 该 scope 的 claims（及可选 splitMeta）。 */
export async function mapChainWriteClaims(
  mapId: string,
  scopeId: string,
  claims: MapChainClaims[],
  splitMeta?: unknown,
): Promise<void> {
  await mapAssertWritable(mapId)
  const key = mapChainAssertPathKey(scopeId)
  const $set: Record<string, unknown> = {
    [`chains.${key}.claims`]: claims,
  }
  if (splitMeta !== undefined) {
    $set[`chains.${key}.splitMeta`] = splitMeta
  }

  const result = await MapModel.updateOne(
    { _id: mapId, [`chains.${key}`]: { $exists: true } },
    { $set },
  )
  if (result.matchedCount === 0) {
    const exists = await MapModel.exists({ _id: mapId })
    if (!exists) {
      throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
    }
    throw new AppError(
      ErrorCode.MAP_SCOPE_NOT_FOUND,
      `Map scope not found: ${scopeId}`,
    )
  }
}

/** verify：只更新单条 claim 的 verifyResult。 */
export async function mapChainWriteVerifyResult(
  mapId: string,
  scopeId: string,
  claimId: string,
  result: unknown,
): Promise<void> {
  await mapAssertWritable(mapId)
  const key = mapChainAssertPathKey(scopeId)
  const updateResult = await MapModel.updateOne(
    { _id: mapId },
    {
      $set: {
        [`chains.${key}.claims.$[c].verifyResult`]: result,
      },
    },
    { arrayFilters: [{ 'c.claimId': claimId }] },
  )
  if (updateResult.matchedCount === 0) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
  if (updateResult.modifiedCount === 0) {
    const scope = await mapChainReadScope(mapId, scopeId)
    if (!scope) {
      throw new AppError(
        ErrorCode.MAP_SCOPE_NOT_FOUND,
        `Map scope not found: ${scopeId}`,
      )
    }
    const found = (scope.claims ?? []).some(c => c.claimId === claimId)
    if (!found) {
      throw new AppError(ErrorCode.CLAIM_NOT_FOUND, `Claim not found: ${claimId}`)
    }
  }
}

/** parse：写入整段 news scope。 */
export async function mapChainWriteScope(
  mapId: string,
  scopeId: string,
  scope: {
    content: string
    context?: Record<string, { value: unknown; visibleToAI: boolean }>
    claims?: MapChainClaims[]
    splitMeta?: unknown
  },
): Promise<void> {
  await mapAssertWritable(mapId)
  const key = mapChainAssertPathKey(scopeId)
  const payload: Record<string, unknown> = {
    content: scope.content,
    context: scope.context ?? {},
    claims: scope.claims ?? [],
  }
  if (scope.splitMeta !== undefined) {
    payload.splitMeta = scope.splitMeta
  }

  const result = await MapModel.updateOne(
    { _id: mapId },
    { $set: { [`chains.${key}`]: payload } },
  )
  if (result.matchedCount === 0) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
}

/** UI：路径级更新 content/context；scope 不存在时创建空 scope。 */
export async function mapChainWriteContent(
  mapId: string,
  scopeId: string,
  patch: {
    content?: string
    context?: Record<string, { value: unknown; visibleToAI: boolean }>
  },
): Promise<void> {
  await mapAssertWritable(mapId)
  const key = mapChainAssertPathKey(scopeId)
  const exists = await MapModel.exists({ _id: mapId })
  if (!exists) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }

  const current = await mapChainReadScope(mapId, scopeId)
  if (!current) {
    await MapModel.updateOne(
      { _id: mapId },
      {
        $set: {
          [`chains.${key}`]: {
            content: patch.content ?? '',
            context: patch.context ?? {},
            claims: [],
          },
        },
      },
    )
    return
  }

  const $set: Record<string, unknown> = {}
  if (patch.content !== undefined) {
    $set[`chains.${key}.content`] = patch.content
  }
  if (patch.context !== undefined) {
    $set[`chains.${key}.context`] = patch.context
  }
  if (Object.keys($set).length === 0) return

  await MapModel.updateOne({ _id: mapId }, { $set })
}
