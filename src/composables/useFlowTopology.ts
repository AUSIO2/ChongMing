import { computed, type Ref } from 'vue'
import type { FlowNodeVM, LayoutEdge, LayoutNode } from '../types/flow'

const AGENT_W = 108
const AGENT_H = 42
const INFO_W = 80
const INFO_H = 30
const BRIDGE_W = 88
const BRIDGE_H = 34

const PAD_X = 36
const PAD_Y = 36
const ROW_GAP = 88
/** 列间距：节点宽 + 可视间隙（约 56px） */
const GAP_X = 164

const X_LOAD = PAD_X
const X_WORKER = X_LOAD + GAP_X
const X_CLAIM = X_WORKER + GAP_X
const X_VERIFY_WORKER = X_CLAIM + GAP_X
const X_OPINION = X_VERIFY_WORKER + GAP_X

function nodeSize(node: FlowNodeVM) {
  if (node.isBridge) return { width: BRIDGE_W, height: BRIDGE_H }
  if (node.nodeCategory === 'info') return { width: INFO_W, height: INFO_H }
  return { width: AGENT_W, height: AGENT_H }
}

function isCanvasNode(node: FlowNodeVM): boolean {
  return node.phase !== 'hidden'
}

function alignY(parentY: number, parentH: number, childH: number): number {
  return parentY + (parentH - childH) / 2
}

function isMergeSource(agentName?: string): boolean {
  return !agentName || agentName === 'merge'
}

/**
 * 以 claim 行为单位布局：每行 = 拆分 Worker（可选）→ 桥接事实 → 核查链
 */
function layoutOnCanvas(nodes: FlowNodeVM[]): LayoutNode[] {
  const canvasNodes = nodes.filter(isCanvasNode)
  const placed = new Map<string, LayoutNode>()

  const load = canvasNodes.find(n => n.id === 'split:load')
  const bridges = canvasNodes
    .filter(n => n.isBridge)
    .sort((a, b) => (a.spawnIndex ?? 0) - (b.spawnIndex ?? 0))

  const splitWorkers = canvasNodes
    .filter(n => n.stage === 'split' && n.agentRole === 'worker')
    .sort((a, b) => (a.spawnIndex ?? 0) - (b.spawnIndex ?? 0))

  const infoClaims = canvasNodes.filter(n => n.infoType === 'claim' && !n.isBridge && !n.isPreview)
  const previewClaims = canvasNodes
    .filter(n => n.isPreview)
    .sort((a, b) => (a.spawnIndex ?? 0) - (b.spawnIndex ?? 0))

  function put(node: FlowNodeVM, x: number, y: number) {
    const size = nodeSize(node)
    placed.set(node.id, { ...node, x, y, width: size.width, height: size.height })
  }

  if (bridges.length) {
    const blockH = bridges.length * ROW_GAP
    if (load) {
      put(load, X_LOAD, PAD_Y + blockH / 2 - AGENT_H / 2)
    }

    bridges.forEach((bridge, row) => {
      const rowY = PAD_Y + row * ROW_GAP + (ROW_GAP - BRIDGE_H) / 2
      put(bridge, X_CLAIM, rowY)

      if (!isMergeSource(bridge.agentName)) {
        const worker = splitWorkers.find(w => w.agentName === bridge.agentName)
        if (worker) {
          put(worker, X_WORKER, alignY(rowY, BRIDGE_H, AGENT_H))
        }
      }

      const verifyWorkers = canvasNodes
        .filter(n => n.stage === 'verify' && n.agentRole === 'worker' && n.claimId === bridge.claimId)
        .sort((a, b) => (a.spawnIndex ?? 0) - (b.spawnIndex ?? 0))

      verifyWorkers.forEach((vw) => {
        put(vw, X_VERIFY_WORKER, alignY(rowY, BRIDGE_H, AGENT_H))
        for (const op of canvasNodes.filter(n => n.parentId === vw.id)) {
          put(op, X_OPINION, alignY(rowY, BRIDGE_H, INFO_H))
        }
      })
    })
  } else {
    type Row = { worker?: FlowNodeVM; claim?: FlowNodeVM }
    const rows: Row[] = []
    const workerRowPlaced = new Set<string>()

    for (const worker of splitWorkers) {
      const workerClaims = infoClaims
        .filter(c => c.parentId === worker.id)
        .sort((a, b) => (a.claimIndex ?? 0) - (b.claimIndex ?? 0))
      if (workerClaims.length) {
        for (const claim of workerClaims) {
          rows.push({ worker, claim })
        }
      } else {
        rows.push({ worker })
      }
    }

    for (const preview of previewClaims) {
      rows.push({ claim: preview })
    }

    const rowCount = Math.max(rows.length, 1)
    const blockH = rowCount * ROW_GAP
    if (load) {
      put(load, X_LOAD, PAD_Y + blockH / 2 - AGENT_H / 2)
    }

    rows.forEach((row, index) => {
      if (row.worker && !workerRowPlaced.has(row.worker.id)) {
        put(row.worker, X_WORKER, PAD_Y + index * ROW_GAP + (ROW_GAP - AGENT_H) / 2)
        workerRowPlaced.add(row.worker.id)
      }
      if (row.claim) {
        const h = row.claim.isPreview ? BRIDGE_H : INFO_H
        put(row.claim, X_CLAIM, PAD_Y + index * ROW_GAP + (ROW_GAP - h) / 2)
      }
    })
  }

  return [...placed.values()]
}

function buildEdges(nodes: LayoutNode[]): LayoutEdge[] {
  const edges: LayoutEdge[] = []
  const byId = new Map(nodes.map(n => [n.id, n]))

  function pushEdge(
    from: LayoutNode | undefined,
    to: LayoutNode | undefined,
    id: string,
    edgeKind: LayoutEdge['edgeKind'] = 'pipeline',
  ) {
    if (!from || !to) return
    const phase = from.phase === 'done' && to.phase === 'done' ? 'visible' : 'entering'
    edges.push({
      id,
      from: from.id,
      to: to.id,
      x1: from.x + from.width,
      y1: from.y + from.height / 2,
      x2: to.x,
      y2: to.y + to.height / 2,
      phase,
      edgeKind,
    })
  }

  const load = byId.get('split:load')
  const splitWorkers = nodes.filter(n => n.stage === 'split' && n.agentRole === 'worker')
  const infoClaims = nodes.filter(n => n.infoType === 'claim' && !n.isBridge)
  const bridges = nodes.filter(n => n.isBridge)

  if (bridges.length) {
    const placedWorkers = new Set<string>()

    for (const bridge of bridges) {
      const worker = !isMergeSource(bridge.agentName)
        ? splitWorkers.find(w => w.agentName === bridge.agentName)
        : undefined

      if (worker && byId.has(worker.id)) {
        if (!placedWorkers.has(worker.id)) {
          pushEdge(load, byId.get(worker.id), `e-load-${worker.id}`)
          placedWorkers.add(worker.id)
        }
        pushEdge(byId.get(worker.id), byId.get(bridge.id), `e-w-b-${bridge.id}`, 'graphBridge')
      } else if (load) {
        const from = byId.get('split:load')!
        const to = byId.get(bridge.id)!
        edges.push({
          id: `e-load-b-${bridge.id}`,
          from: from.id,
          to: to.id,
          x1: from.x + from.width * 0.6,
          y1: from.y + from.height,
          x2: to.x,
          y2: to.y + to.height / 2,
          phase: from.phase === 'done' && to.phase === 'done' ? 'visible' : 'entering',
          edgeKind: 'mergeBridge',
        })
      }

      const verifyWorkers = nodes.filter(
        n => n.stage === 'verify' && n.agentRole === 'worker' && n.claimId === bridge.claimId,
      )
      for (const vw of verifyWorkers) {
        pushEdge(byId.get(bridge.id), byId.get(vw.id), `e-b-vw-${vw.id}`, 'graphBridge')
        for (const op of nodes.filter(n => n.parentId === vw.id)) {
          pushEdge(byId.get(vw.id), byId.get(op.id), `e-vw-op-${op.id}`, 'infoFanOut')
        }
      }
    }
  } else {
    const loadEdges = new Set<string>()
    for (const w of splitWorkers) {
      const claims = infoClaims
        .filter(c => c.parentId === w.id)
        .sort((a, b) => (a.claimIndex ?? 0) - (b.claimIndex ?? 0))
      if (!claims.length) {
        pushEdge(load, byId.get(w.id), `e-load-${w.id}`)
        continue
      }
      for (const claim of claims) {
        if (!loadEdges.has(w.id)) {
          pushEdge(load, byId.get(w.id), `e-load-${w.id}`)
          loadEdges.add(w.id)
        }
        pushEdge(byId.get(w.id), byId.get(claim.id), `e-w-c-${claim.id}`, 'infoFanOut')
      }
    }
    const previews = nodes.filter(n => n.isPreview)
    for (const preview of previews) {
      pushEdge(load, byId.get(preview.id), `e-load-p-${preview.id}`, 'mergeBridge')
    }
  }

  return edges
}

export function useFlowTopology(flowNodes: Ref<FlowNodeVM[]>) {
  const layoutNodes = computed(() => layoutOnCanvas(flowNodes.value))
  const layoutEdges = computed(() => buildEdges(layoutNodes.value))

  const viewBox = computed(() => {
    const nodes = layoutNodes.value
    if (!nodes.length) return '0 0 640 240'
    const maxX = Math.max(...nodes.map(n => n.x + n.width)) + PAD_X
    const maxY = Math.max(...nodes.map(n => n.y + n.height)) + PAD_Y
    return `0 0 ${maxX} ${Math.max(maxY, 200)}`
  })

  return { layoutNodes, layoutEdges, viewBox }
}

/** 运行时进度节点（IPC progress 事件仍用旧 id） */
export function createInitialFlowNodes(graphType: 'split' | 'verify' | null): FlowNodeVM[] {
  const load = graphType === 'verify' ? 'loadClaim' : 'loadNews'
  const stage = graphType === 'verify' ? 'verify' : 'split'
  const loadLabel = graphType === 'verify' ? '加载 Claim' : '加载新闻'
  return [
    {
      id: load,
      nodeCategory: 'agent',
      kind: load,
      label: loadLabel,
      stage,
      agentRole: 'load',
      phase: 'hidden',
    },
    {
      id: 'route',
      nodeCategory: 'agent',
      kind: 'route',
      label: '路由',
      stage,
      agentRole: 'route',
      phase: 'hidden',
    },
    {
      id: 'merge',
      nodeCategory: 'agent',
      kind: 'merge',
      label: '合并',
      stage,
      agentRole: 'merge',
      phase: 'hidden',
    },
    {
      id: 'save',
      nodeCategory: 'agent',
      kind: 'save',
      label: '保存',
      stage,
      agentRole: 'save',
      phase: 'hidden',
    },
  ]
}
