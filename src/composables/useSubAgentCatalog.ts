import { computed, type Ref } from 'vue'
import type { GraphType, RouteInstruction } from '../../electron/api/types'
import {
  getSubAgentCatalog,
  type SubAgentCatalogEntry,
  type SubAgentModule,
} from '../../electron/api/sub-agent-catalog'

function resolveModule(
  graphType: GraphType | null,
  flowPhase: string,
): SubAgentModule {
  if (flowPhase === 'awaitingVerifyRoute' || graphType === 'verify') return 'verify'
  return 'split'
}

export function useSubAgentCatalog(
  graphType: Ref<GraphType | null>,
  flowPhase: Ref<string>,
  _routeInstructions: Ref<RouteInstruction[]>,
) {
  const catalog = computed(() =>
    getSubAgentCatalog(resolveModule(graphType.value, flowPhase.value)),
  )

  function agentsForRouteIndex(_index: number): SubAgentCatalogEntry[] {
    return catalog.value
  }

  return { catalog, agentsForRouteIndex }
}
