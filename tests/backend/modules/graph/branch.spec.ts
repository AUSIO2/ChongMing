import { describe, expect, it } from 'vitest'
import type { GraphDocument } from '../../../../backend/modules/graph/graph-record'
import type { GraphChanges, GraphEdge, GraphNode } from '../../../../contracts/graph'
import {
  branchReadImpact,
  branchReadScope,
  branchReadSnapshot,
  branchScopesOverlap,
  branchValidateImpact,
  branchValidateMutation,
  branchValidateNewRoots,
} from '../../../../backend/modules/graph/branch-state'

const now = new Date(0).toISOString()
const branchNode = (id: string): GraphNode => ({
  id, revision: 0, typeId: 'fixture.data', typeVersion: 1, payload: { id }, createdAt: now, updatedAt: now,
})
const branchEdge = (id: string, from: string, to: string, kind: 'successor' | 'reference' = 'successor'): GraphEdge => ({
  id, from, to, kind, revision: 0, createdAt: now, updatedAt: now,
})

function branchFixture(): GraphDocument {
  return {
    id: 'map-1', workspaceId: 'workspace-1', revision: 0, name: 'Branches',
    nodes: ['root-a', 'a-1', 'shared', 'root-b', 'b-1', 'context'].map(branchNode),
    edges: [branchEdge('a-next', 'root-a', 'a-1'), branchEdge('a-shared', 'a-1', 'shared'),
      branchEdge('b-next', 'root-b', 'b-1'), branchEdge('b-shared', 'b-1', 'shared'), branchEdge('context-ref', 'context', 'a-1', 'reference')],
    runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now,
  }
}

function isolatedBranches(): GraphDocument {
  const document = branchFixture()
  document.edges = document.edges.filter(edge => edge.id !== 'a-shared' && edge.id !== 'b-shared')
  return document
}

describe('Data branch rules', () => {
  it('walks only actual successor edges and detects shared descendants', () => {
    const document = branchFixture()
    const left = branchReadScope(document, ['root-a']), right = branchReadScope(document, ['root-b'])
    expect(left.nodeIds).toEqual(['a-1', 'root-a', 'shared'])
    expect(left.edgeIds).toEqual(['a-next', 'a-shared'])
    expect(left.nodeIds).not.toContain('context')
    expect(branchScopesOverlap(left, right)).toBe(true)
    expect(branchScopesOverlap(left, branchReadScope(document, ['context']))).toBe(false)
  })

  it('keeps an unrelated branch stable and changes the summary for every relevant content or relation change', () => {
    const document = branchFixture(), initial = branchReadSnapshot(document, ['root-a']).version
    const unrelated = structuredClone(document)
    unrelated.nodes.find(node => node.id === 'root-b')!.payload = { id: 'unrelated update' }
    unrelated.nodes.find(node => node.id === 'root-b')!.revision++
    expect(branchReadSnapshot(unrelated, ['root-a']).version).toBe(initial)

    const payload = structuredClone(document)
    payload.nodes.find(node => node.id === 'a-1')!.payload = { id: 'updated in branch' }
    payload.nodes.find(node => node.id === 'a-1')!.revision++
    expect(branchReadSnapshot(payload, ['root-a']).version).not.toBe(initial)

    const incoming = structuredClone(document)
    incoming.edges.push(branchEdge('incoming-next', 'context', 'a-1'))
    expect(branchReadSnapshot(incoming, ['root-a']).version).not.toBe(initial)

    const outgoing = structuredClone(document)
    outgoing.edges.push(branchEdge('outgoing-next', 'a-1', 'context'))
    expect(branchReadSnapshot(outgoing, ['root-a']).version).not.toBe(initial)
    expect(branchReadSnapshot(outgoing, ['root-a']).scope.nodeIds).toContain('context')

    const reference = structuredClone(document)
    reference.edges.find(edge => edge.id === 'context-ref')!.revision++
    expect(branchReadSnapshot(reference, ['root-a']).version).not.toBe(initial)
  })

  it('includes old and new relation endpoints and node deletion side effects', () => {
    const document = branchFixture()
    const moved = branchReadImpact(document, { edges: { put: [{ id: 'a-next', kind: 'successor', from: 'root-a', to: 'b-1' }] } })
    expect(moved.nodeIds).toEqual(['a-1', 'b-1', 'root-a'])
    const removed = branchReadImpact(document, { nodes: { remove: ['a-1'] } })
    expect(removed.nodeIds).toEqual(['a-1', 'context', 'root-a', 'shared'])
    expect(removed.edgeIds).toEqual(['a-next', 'a-shared', 'context-ref'])
  })

  it('rejects a mutation whose real impact leaves the acquired scope', () => {
    const document = branchFixture(), scope = branchReadScope(document, ['root-a'])
    const safe = branchReadImpact(document, { nodes: { put: [{ id: 'a-1', typeId: 'fixture.data', typeVersion: 1, payload: { id: 'updated' } }] } })
    expect(() => branchValidateImpact(scope, safe)).not.toThrow()
    const crossing = branchReadImpact(document, { edges: { put: [{ id: 'a-next', kind: 'successor', from: 'root-a', to: 'b-1' }] } })
    expect(() => branchValidateImpact(scope, crossing)).toThrowError(expect.objectContaining({ code: 'BRANCH_SCOPE_CONFLICT' }))
  })

  it('atomically expands a branch when a new successor becomes reachable', () => {
    const before = isolatedBranches(), authorized = branchReadScope(before, ['root-a'])
    const changes: GraphChanges = {
      nodes: { put: [{ id: 'a-2', typeId: 'fixture.data', typeVersion: 1, payload: { id: 'a-2' } }] },
      edges: { put: [{ id: 'a-2-next', kind: 'successor', from: 'a-1', to: 'a-2' }] },
    }
    const after = structuredClone(before)
    after.nodes.push(branchNode('a-2'))
    after.edges.push(branchEdge('a-2-next', 'a-1', 'a-2'))

    const next = branchValidateMutation(before, after, changes, authorized)
    expect(next?.scope.nodeIds).toEqual(['a-1', 'a-2', 'root-a'])
    expect(next?.version).not.toBe(branchReadSnapshot(before, ['root-a']).version)
  })

  it('recomputes the whole successor closure when deleting an edge strands descendants', () => {
    const before = branchFixture(), authorized = branchReadScope(before, ['root-a'])
    const changes: GraphChanges = { edges: { remove: ['a-next'] } }
    const after = structuredClone(before)
    after.edges = after.edges.filter(edge => edge.id !== 'a-next')

    const next = branchValidateMutation(before, after, changes, authorized)
    expect(next?.scope.nodeIds).toEqual(['root-a'])
    expect(next?.scope.nodeIds).not.toContain('a-1')
    expect(next?.scope.nodeIds).not.toContain('shared')
  })

  it('rejects attaching an existing external subtree without already covering its root', () => {
    const before = isolatedBranches(), authorized = branchReadScope(before, ['root-a'])
    const changes: GraphChanges = { edges: { put: [{ id: 'cross-next', kind: 'successor', from: 'a-1', to: 'root-b' }] } }
    const after = structuredClone(before)
    after.edges.push(branchEdge('cross-next', 'a-1', 'root-b'))

    expect(() => branchValidateMutation(before, after, changes, authorized))
      .toThrowError(expect.objectContaining({ code: 'BRANCH_SCOPE_CONFLICT' }))
  })

  it('rejects deleting only part of a multi-root authorization', () => {
    const before = branchFixture(), authorized = branchReadScope(before, ['root-a', 'root-b'])
    const changes: GraphChanges = { nodes: { remove: ['root-a'] } }
    const after = structuredClone(before)
    after.nodes = after.nodes.filter(node => node.id !== 'root-a')
    after.edges = after.edges.filter(edge => edge.from !== 'root-a' && edge.to !== 'root-a')

    expect(() => branchValidateMutation(before, after, changes, authorized))
      .toThrowError(expect.objectContaining({ code: 'BRANCH_SCOPE_CONFLICT' }))
  })

  it('uses the null-version path only for an independent successor tree made entirely of new nodes', () => {
    const before = isolatedBranches()
    const changes: GraphChanges = {
      nodes: { put: [
        { id: 'new-root', typeId: 'fixture.data', typeVersion: 1, payload: { id: 'new-root' } },
        { id: 'new-child', typeId: 'fixture.data', typeVersion: 1, payload: { id: 'new-child' } },
      ] },
      edges: { put: [{ id: 'new-next', kind: 'successor', from: 'new-root', to: 'new-child' }] },
    }
    const after = structuredClone(before)
    after.nodes.push(branchNode('new-root'), branchNode('new-child'))
    after.edges.push(branchEdge('new-next', 'new-root', 'new-child'))
    expect(branchValidateNewRoots(before, after, ['new-root'], changes).scope.nodeIds).toEqual(['new-child', 'new-root'])

    const touchesExisting: GraphChanges = { nodes: { put: changes.nodes!.put }, edges: { put: [
      { id: 'new-cross', kind: 'successor', from: 'new-root', to: 'root-a' },
    ] } }
    const crossed = structuredClone(before)
    crossed.nodes.push(branchNode('new-root'), branchNode('new-child'))
    crossed.edges.push(branchEdge('new-cross', 'new-root', 'root-a'))
    expect(() => branchValidateNewRoots(before, crossed, ['new-root'], touchesExisting))
      .toThrowError(expect.objectContaining({ code: 'BRANCH_SCOPE_CONFLICT' }))

    const unreachable: GraphChanges = { nodes: { put: changes.nodes!.put }, edges: { put: [
      { id: 'new-reference', kind: 'reference', from: 'new-root', to: 'new-child' },
    ] } }
    const referenced = structuredClone(before)
    referenced.nodes.push(branchNode('new-root'), branchNode('new-child'))
    referenced.edges.push(branchEdge('new-reference', 'new-root', 'new-child', 'reference'))
    expect(() => branchValidateNewRoots(before, referenced, ['new-root'], unreachable))
      .toThrowError(expect.objectContaining({ code: 'BRANCH_SCOPE_CONFLICT' }))
  })
})
