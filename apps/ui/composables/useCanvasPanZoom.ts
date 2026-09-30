// 画布交互：维护平移与缩放，支持滚轮、拖动、适应布局和区域聚焦。
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

/**
 * 持有画布缩放和平移状态，处理指针与滚轮交互，并提供适应内容和聚焦区域操作。
 *
 * @param options 组件持有的容器、SVG 与内容尺寸引用；这里只读引用值，变换状态由本组合函数管理。
 */
export function useCanvasPanZoom(options: CanvasPanZoomOptions) {
  const scale = ref(1)
  const translateX = ref(0)
  const translateY = ref(0)

  const svgStyle = computed(() => /* 将缩放和平移状态转换为以左上角为原点的 SVG 样式。 */ ({
    transform: `translate(${translateX.value}px, ${translateY.value}px) scale(${scale.value})`,
    transformOrigin: '0 0',
  }))

  const scalePercent = computed(() => /* 把当前缩放比例格式化为工具栏显示的百分比。 */ `${Math.round(scale.value * 100)}%`)

  /**
   * 将缩放比例限制在 0.25 到 3 之间。
   *
   * @param next 尚未限幅的目标缩放倍数，无单位。
   */
  function clampScale(next: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
  }

  /**
   * 按倍率缩放，并在提供锚点时调整平移量，使锚点对应的内容保持原位。
   *
   * @param factor 相对当前比例的乘数，大于 1 放大、小于 1 缩小。
   * @param anchor 可选的 SVG 边界相对像素位置；指定后固定其内容位置，省略则只更新缩放比例。
   */
  function zoomAt(
    factor: number,
    anchor?: { x: number; y: number }
  ) {
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

  /**
   * 将指针的屏幕位置换算为相对 SVG 边界的位置。
   *
   * @param e 带视口像素坐标的指针信息，只读取位置字段。
   */
  function localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const svg = options.svgRef.value
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function viewCenterPoint(): { x: number; y: number } | null {
    // 计算容器中心相对 SVG 边界的位置，供工具栏按钮作为缩放锚点。
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

  /**
   * 阻止默认滚动，按修饰键选择锚点缩放或水平、垂直平移。
   *
   * @param e 容器派发的滚轮事件；修饰键决定缩放或平移，并阻止默认滚动。
   */
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

  /**
   * 在画布空白区域按下左键或中键时开始平移，并捕获当前指针。
   *
   * @param e 容器派发的按下事件，目标和按键用于排除节点操作，pointerId 用于捕获指针。
   */
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

  /**
   * 平移期间按指针相对起点的位移更新画布偏移。
   *
   * @param e 窗口位置持续变化的指针事件，仅在已开始平移时使用其视口坐标。
   */
  function onPointerMove(e: PointerEvent) {
    if (!panning) return
    translateX.value = panOriginX + (e.clientX - panStartX)
    translateY.value = panOriginY + (e.clientY - panStartY)
  }

  /**
   * 结束画布平移并释放捕获的指针。
   *
   * @param e 结束或取消平移的指针事件，pointerId 用于释放捕获。
   */
  function onPointerUp(e: PointerEvent) {
    if (!panning) return
    panning = false
    options.containerRef.value?.releasePointerCapture(e.pointerId)
  }

  function zoomIn() {
    // 围绕当前可见区域中心放大一档。
    zoomAt(BUTTON_ZOOM_STEP, viewCenterPoint() ?? undefined)
  }

  function zoomOut() {
    // 围绕当前可见区域中心缩小一档。
    zoomAt(1 / BUTTON_ZOOM_STEP, viewCenterPoint() ?? undefined)
  }

  function resetView() {
    // 恢复原始缩放比例并清除平移偏移。
    scale.value = 1
    translateX.value = 0
    translateY.value = 0
  }

  /**
   * 计算容器内可用区域，将指定布局矩形等比缩放并居中显示。
   *
   * @param x 待适应矩形左边界的缩放前布局坐标。
   * @param y 待适应矩形上边界的缩放前布局坐标。
   * @param cw 待适应矩形的布局宽度；非正数时恢复原始视图。
   * @param ch 待适应矩形的布局高度；非正数时恢复原始视图。
   */
  function fitLayoutRect(
    x: number,
    y: number,
    cw: number,
    ch: number
  ) {
    const container = options.containerRef.value
    if (!container) {
      resetView()
      return
    }

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
    translateX.value = pad + (availW - cw * nextScale) / 2 - x * nextScale
    translateY.value = pad + (availH - ch * nextScale) / 2 - y * nextScale
  }

  function fitToView() {
    // 使用完整内容范围计算适应当前容器的画布视图。
    fitLayoutRect(0, 0, options.contentWidth.value, options.contentHeight.value)
  }

  /**
   * 通过 SVG 屏幕变换矩阵，将布局矩形的四角换算为容器内的可见边界。
   *
   * @param x 矩形左上角的 SVG 用户空间横坐标。
   * @param y 矩形左上角的 SVG 用户空间纵坐标。
   * @param width 矩形在 SVG 用户空间中的宽度。
   * @param height 矩形在 SVG 用户空间中的高度。
   */
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

  /**
   * 在目标矩形超出可见区域时仅调整必要的平移量，保留当前缩放。
   *
   * @param x 待聚焦矩形左上角的布局横坐标。
   * @param y 待聚焦矩形左上角的布局纵坐标。
   * @param width 待聚焦矩形的布局宽度，供可见边界检查。
   * @param height 待聚焦矩形的布局高度，供可见边界检查。
   */
  function focusLayoutRect(
    x: number,
    y: number,
    width: number,
    height: number
  ) {
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
    // 挂载后安装可阻止默认行为的滚轮监听。
    const el = options.containerRef.value
    el?.addEventListener('wheel', onWheel, { passive: false })
  })

  onUnmounted(() => {
    // 卸载时移除画布容器的滚轮监听。
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
    fitLayoutRect,
    focusLayoutRect,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
