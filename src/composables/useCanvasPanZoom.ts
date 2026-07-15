import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue'

const MIN_SCALE = 0.25
const MAX_SCALE = 3
/** 工具栏 +/- 每档缩放比 */
const BUTTON_ZOOM_STEP = 1.12
/** 滚轮指数系数，越大越灵敏 */
const WHEEL_ZOOM_INTENSITY = 0.002

export interface CanvasPanZoomOptions {
  containerRef: Ref<HTMLElement | null>
  svgRef: Ref<SVGSVGElement | null>
  contentWidth: Ref<number>
  contentHeight: Ref<number>
}

export function useCanvasPanZoom(options: CanvasPanZoomOptions) {
  const scale = ref(1)
  const translateX = ref(0)
  const translateY = ref(0)

  const svgStyle = computed(() => ({
    transform: `translate(${translateX.value}px, ${translateY.value}px) scale(${scale.value})`,
    transformOrigin: '0 0',
  }))

  const scalePercent = computed(() => `${Math.round(scale.value * 100)}%`)

  function clampScale(next: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
  }

  function zoomAt(factor: number, anchor?: { x: number; y: number }) {
    const nextScale = clampScale(scale.value * factor)
    if (nextScale === scale.value) return

    if (anchor) {
      const sx = (anchor.x - translateX.value) / scale.value
      const sy = (anchor.y - translateY.value) / scale.value
      scale.value = nextScale
      translateX.value = anchor.x - sx * nextScale
      translateY.value = anchor.y - sy * nextScale
      return
    }

    scale.value = nextScale
  }

  function localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const svg = options.svgRef.value
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function viewCenterPoint(): { x: number; y: number } | null {
    const container = options.containerRef.value
    const svg = options.svgRef.value
    if (!container || !svg) return null
    const cRect = container.getBoundingClientRect()
    const sRect = svg.getBoundingClientRect()
    return {
      x: cRect.left + cRect.width / 2 - sRect.left,
      y: cRect.top + cRect.height / 2 - sRect.top,
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    // 捏合 / Ctrl·Cmd+滚轮 → 缩放；双指滑动 / 普通滚轮 → 平移
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_INTENSITY)
      if (Math.abs(factor - 1) < 1e-4) return
      zoomAt(factor, localPoint(e) ?? undefined)
      return
    }
    translateX.value -= e.deltaX
    translateY.value -= e.deltaY
  }

  let panning = false
  let panStartX = 0
  let panStartY = 0
  let panOriginX = 0
  let panOriginY = 0

  function onPointerDown(e: PointerEvent) {
    const target = e.target as Element
    if (
      target.closest('.fm-node')
      || target.closest('.zoom-controls')
      || target.closest('.canvas-context-menu')
    ) return
    if (e.button !== 0 && e.button !== 1) return
    panning = true
    panStartX = e.clientX
    panStartY = e.clientY
    panOriginX = translateX.value
    panOriginY = translateY.value
    options.containerRef.value?.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: PointerEvent) {
    if (!panning) return
    translateX.value = panOriginX + (e.clientX - panStartX)
    translateY.value = panOriginY + (e.clientY - panStartY)
  }

  function onPointerUp(e: PointerEvent) {
    if (!panning) return
    panning = false
    options.containerRef.value?.releasePointerCapture(e.pointerId)
  }

  function zoomIn() {
    zoomAt(BUTTON_ZOOM_STEP, viewCenterPoint() ?? undefined)
  }

  function zoomOut() {
    zoomAt(1 / BUTTON_ZOOM_STEP, viewCenterPoint() ?? undefined)
  }

  function resetView() {
    scale.value = 1
    translateX.value = 0
    translateY.value = 0
  }

  function fitToView() {
    const container = options.containerRef.value
    if (!container) {
      resetView()
      return
    }

    const cw = options.contentWidth.value
    const ch = options.contentHeight.value
    const rect = container.getBoundingClientRect()
    const pad = 16
    const availW = Math.max(rect.width - pad * 2, 1)
    const availH = Math.max(rect.height - pad * 2, 1)

    if (cw <= 0 || ch <= 0) {
      resetView()
      return
    }

    const nextScale = clampScale(Math.min(availW / cw, availH / ch))
    scale.value = nextScale
    translateX.value = pad + (availW - cw * nextScale) / 2
    translateY.value = pad + (availH - ch * nextScale) / 2
  }

  function layoutRectScreenBounds(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { left: number, top: number, right: number, bottom: number } | null {
    const svg = options.svgRef.value
    const container = options.containerRef.value
    if (!svg || !container) return null

    const ctm = svg.getScreenCTM()
    if (!ctm) return null

    const containerRect = container.getBoundingClientRect()
    const corners = [
      { x, y },
      { x: x + width, y },
      { x, y: y + height },
      { x: x + width, y: y + height },
    ]

    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity

    for (const c of corners) {
      const pt = svg.createSVGPoint()
      pt.x = c.x
      pt.y = c.y
      const sp = pt.matrixTransform(ctm)
      left = Math.min(left, sp.x - containerRect.left)
      top = Math.min(top, sp.y - containerRect.top)
      right = Math.max(right, sp.x - containerRect.left)
      bottom = Math.max(bottom, sp.y - containerRect.top)
    }

    return { left, top, right, bottom }
  }

  function focusLayoutRect(x: number, y: number, width: number, height: number) {
    const container = options.containerRef.value
    if (!container) return

    const pad = 32
    const viewW = container.clientWidth
    const viewH = container.clientHeight
    const bounds = layoutRectScreenBounds(x, y, width, height)
    if (!bounds) return

    if (
      bounds.left >= pad
      && bounds.top >= pad
      && bounds.right <= viewW - pad
      && bounds.bottom <= viewH - pad
    ) {
      return
    }

    let dx = 0
    let dy = 0
    if (bounds.left < pad) dx = pad - bounds.left
    else if (bounds.right > viewW - pad) dx = (viewW - pad) - bounds.right
    if (bounds.top < pad) dy = pad - bounds.top
    else if (bounds.bottom > viewH - pad) dy = (viewH - pad) - bounds.bottom

    if (dx !== 0 || dy !== 0) {
      translateX.value += dx
      translateY.value += dy
    }
  }

  onMounted(() => {
    const el = options.containerRef.value
    el?.addEventListener('wheel', onWheel, { passive: false })
  })

  onUnmounted(() => {
    const el = options.containerRef.value
    el?.removeEventListener('wheel', onWheel)
  })

  return {
    svgStyle,
    scalePercent,
    zoomIn,
    zoomOut,
    resetView,
    fitToView,
    focusLayoutRect,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
