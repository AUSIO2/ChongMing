import { NewsModel } from '../shared/database'
import type {
  CreateClaimInput,
  SplitClaimDTO,
  UpdateClaimInput,
} from './types'

type ClaimRecord = SplitClaimDTO & { verifyResult?: unknown }

function getClaimsArray(doc: { claims?: unknown }): ClaimRecord[] {
  return (doc.claims ?? []) as ClaimRecord[]
}

function nextClaimId(claims: ClaimRecord[]): string {
  const nums = claims
    .map(c => Number.parseInt(c.claimId, 10))
    .filter(n => !Number.isNaN(n))
  return String((nums.length > 0 ? Math.max(...nums) : 0) + 1)
}

async function findNewsOrThrow(newsId: string) {
  const doc = await NewsModel.findById(newsId)
  if (!doc) throw new Error(`News not found: ${newsId}`)
  return doc
}

export async function listClaims(newsId: string): Promise<SplitClaimDTO[]> {
  const doc = await findNewsOrThrow(newsId)
  return getClaimsArray(doc)
}

export async function createClaim(
  newsId: string,
  input: CreateClaimInput,
): Promise<SplitClaimDTO> {
  const doc = await findNewsOrThrow(newsId)
  const claims = getClaimsArray(doc)

  const claimId = input.claimId ?? nextClaimId(claims)
  if (claims.some(c => c.claimId === claimId)) {
    throw new Error(`Claim already exists: ${claimId}`)
  }

  const claim: ClaimRecord = {
    claimId,
    content: input.content,
    category: input.category,
    sourceAgent: input.sourceAgent ?? 'manual',
  }

  claims.push(claim)
  doc.set('claims', claims)
  doc.markModified('claims')
  await doc.save()

  return claim
}

export async function updateClaim(
  newsId: string,
  claimId: string,
  patch: UpdateClaimInput,
): Promise<SplitClaimDTO> {
  const doc = await findNewsOrThrow(newsId)
  const claims = getClaimsArray(doc)
  const index = claims.findIndex(c => c.claimId === claimId)

  if (index === -1) {
    throw new Error(`Claim not found: ${claimId}`)
  }

  const current = claims[index]
  claims[index] = {
    ...current,
    content: patch.content ?? current.content,
    category: patch.category ?? current.category,
    sourceAgent: patch.sourceAgent ?? current.sourceAgent,
  }

  doc.set('claims', claims)
  doc.markModified('claims')
  await doc.save()

  return claims[index]
}

export async function deleteClaim(newsId: string, claimId: string): Promise<void> {
  const doc = await findNewsOrThrow(newsId)
  const claims = getClaimsArray(doc)
  const nextClaims = claims.filter(c => c.claimId !== claimId)

  if (nextClaims.length === claims.length) {
    throw new Error(`Claim not found: ${claimId}`)
  }

  doc.set('claims', nextClaims)
  doc.markModified('claims')
  await doc.save()
}
