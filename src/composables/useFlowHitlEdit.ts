import { computed, ref, watch, type Ref } from 'vue'
import type {
  GraphInterruptNode,
  GraphStatePatch,
  GraphType,
  Priority,
  RouteInstruction,
  SplitGraphStateDTO,
  VerifyGraphStateDTO,
} from '../../electron/api/types'
import { isClaimInList } from '../utils/claimMatch'

const priorities: Priority[] = ['high', 'medium', 'low']
const scores = [1, 0.5, 0] as const
const MAX_HISTORY = 50

function isSplitState(s: SplitGraphStateDTO | VerifyGraphStateDTO): s is SplitGraphStateDTO {
  return 'mergedClaims' in s
}

type MergedClaim = { content: string; category?: string; sourceAgent?: string }

interface EditSnapshot {
  routeInstructions: RouteInstruction[]
  mergedClaims: MergedClaim[]
  finalScore: 1 | 0.5 | 0
  finalReason: string
}

function cloneSnapshot(
  routeInstructions: RouteInstruction[],
  mergedClaims: MergedClaim[],
  finalScore: 1 | 0.5 | 0,
  finalReason: string,
): EditSnapshot {
  return {
    routeInstructions: routeInstructions.map(r => ({ ...r })),
    mergedClaims: mergedClaims.map(c => ({ ...c })),
    finalScore,
    finalReason,
  }
}

function snapshotsEqual(a: EditSnapshot, b: EditSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function useFlowHitlEdit(
  graphState: Ref<SplitGraphStateDTO | VerifyGraphStateDTO | null>,
  graphType: Ref<GraphType | null>,
  nextNode: Ref<GraphInterruptNode | null>,
) {
  const routeInstructions = ref<RouteInstruction[]>([])
  const mergedClaims = ref<MergedClaim[]>([])
  const finalScore = ref<1 | 0.5 | 0>(0.5)
  const finalReason = ref('')

  const history = ref<EditSnapshot[]>([])
  const historyIndex = ref(-1)
  let restoring = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function applySnapshot(snap: EditSnapshot) {
    if (debounceTimer) clearTimeout(debounceTimer)
    restoring = true
    routeInstructions.value = snap.routeInstructions.map(r => ({ ...r }))
    mergedClaims.value = snap.mergedClaims.map(c => ({ ...c }))
    finalScore.value = snap.finalScore
    finalReason.value = snap.finalReason
    restoring = false
  }

  function resetHistory() {
    const snap = cloneSnapshot(
      routeInstructions.value,
      mergedClaims.value,
      finalScore.value,
      finalReason.value,
    )
    history.value = [snap]
    historyIndex.value = 0
  }

  function pushHistory() {
    if (restoring) return
    const snap = cloneSnapshot(
      routeInstructions.value,
      mergedClaims.value,
      finalScore.value,
      finalReason.value,
    )
    const current = history.value[historyIndex.value]
    if (current && snapshotsEqual(current, snap)) return

    const truncated = history.value.slice(0, historyIndex.value + 1)
    truncated.push(snap)
    if (truncated.length > MAX_HISTORY) truncated.shift()
    history.value = truncated
    historyIndex.value = truncated.length - 1
  }

  function scheduleHistoryPush() {
    if (restoring) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (restoring) return
      pushHistory()
    }, 400)
  }

  function undo() {
    if (historyIndex.value <= 0) return
    if (debounceTimer) clearTimeout(debounceTimer)
    historyIndex.value -= 1
    applySnapshot(history.value[historyIndex.value])
  }

  const canUndo = computed(() => historyIndex.value > 0)

  watch(
    () => graphState.value,
    (state) => {
      if (!state) return
      restoring = true
      routeInstructions.value = state.routeInstructions.map(r => ({ ...r }))
      if (isSplitState(state)) {
        mergedClaims.value = state.mergedClaims.map(c => ({ ...c }))
      } else {
        finalScore.value = state.finalScore
        finalReason.value = state.finalReason
      }
      restoring = false
      resetHistory()
    },
    { immediate: true },
  )

  watch(
    [routeInstructions, mergedClaims, finalScore, finalReason],
    scheduleHistoryPush,
    { deep: true },
  )

  function addRoute() {
    pushHistory()
    routeInstructions.value.push({ agentName: '', priority: 'medium', hint: '' })
  }

  function removeRoute(index: number) {
    pushHistory()
    routeInstructions.value.splice(index, 1)
  }

  function addClaim() {
    pushHistory()
    mergedClaims.value.push({ content: '', category: '', sourceAgent: 'manual' })
  }

  function removeClaim(index: number) {
    pushHistory()
    mergedClaims.value.splice(index, 1)
  }

  const removedSubAgentClaims = computed(() => {
    const state = graphState.value
    if (!state || !isSplitState(state)) return [] as MergedClaim[]
    const removed: MergedClaim[] = []
    for (const result of state.subAgentResults) {
      for (const claim of result.claims) {
        if (!isClaimInList(claim, mergedClaims.value)) {
          removed.push({ ...claim })
        }
      }
    }
    return removed
  })

  function restoreClaim(claim: MergedClaim) {
    if (isClaimInList(claim, mergedClaims.value)) return
    pushHistory()
    mergedClaims.value.push({ ...claim })
  }

  function isSplitCommitNode(node: GraphInterruptNode | null) {
    return node === 'merge' || node === 'save'
  }

  function buildPatch(): GraphStatePatch {
    const node = nextNode.value
    if (!node) return null

    if (node === 'subAgent') {
      const routes = routeInstructions.value
        .map(r => ({ ...r }))
        .filter(r => r.agentName.trim())
      return routes.length ? { routeInstructions: routes } : null
    }

    if (graphType.value === 'split' && graphState.value && isSplitState(graphState.value)) {
      if (isSplitCommitNode(node)) {
        const claims = mergedClaims.value
          .map(c => ({ ...c }))
          .filter(c => c.content.trim())
        return claims.length ? { mergedClaims: claims } : null
      }
    }

    if (isSplitCommitNode(node) && graphType.value === 'verify') {
      return {
        finalScore: finalScore.value,
        finalReason: finalReason.value,
      }
    }

    return {
      finalScore: finalScore.value,
      finalReason: finalReason.value,
    }
  }

  return {
    priorities,
    scores,
    routeInstructions,
    mergedClaims,
    finalScore,
    finalReason,
    addRoute,
    removeRoute,
    addClaim,
    removeClaim,
    restoreClaim,
    removedSubAgentClaims,
    buildPatch,
    undo,
    canUndo,
    isSplitState,
  }
}
