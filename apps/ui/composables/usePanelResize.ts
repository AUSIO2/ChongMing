// 左右侧栏按实际宿主共享宽度预算，缩窗只改变有效尺寸，不覆盖用户保存的偏好。
import { computed, onMounted, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import { useMouseResize } from './useMouseResize'

const STORAGE_KEY = 'chongming.panelWidths'

interface PanelWidths {
  left: number
  right: number
}

/**
 * 恢复已保存的左右栏宽度，为缺失值或存储异常使用传入默认值。
 *
 * @param defaults 调用者提供的像素宽度后备值；未保存或读取失败时直接返回，不修改对象。
 */
function loadWidths(defaults: PanelWidths): PanelWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<PanelWidths>
    return {
      left: typeof parsed?.left === 'number' && Number.isFinite(parsed.left) ? Math.min(400, Math.max(160, parsed.left)) : defaults.left,
      right: typeof parsed?.right === 'number' && Number.isFinite(parsed.right) ? Math.min(520, Math.max(260, parsed.right)) : defaults.right,
    }
  } catch {
    return defaults
  }
}

/**
 * 保存左右栏宽度，存储失败时继续使用内存中的布局。
 *
 * @param widths 本次左右侧栏宽度快照，单位为 CSS 像素。
 */
function saveWidths(widths: PanelWidths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths))
  } catch {
    /* 浏览器存储不可用时仍保留本次布局调整。 */
  }
}

/**
 * 持有左右侧栏宽度并提供各自的拖动操作与持久化。
 *
 * @param container 真正承载三栏的外壳，宽度可以独立于浏览器窗口变化。
 * @param rightVisible 单页等模式隐藏右栏时，不再为它预留预算。
 * @param defaults 未保存的宽度后备值；默认左200、右320。
 */
export function usePanelResize(
  container: Readonly<Ref<HTMLElement | null>>,
  rightVisible: Readonly<Ref<boolean>>,
  defaults: PanelWidths = { left: 200, right: 320 },
): {
  leftWidth: ComputedRef<number>; rightWidth: ComputedRef<number>; compact: ComputedRef<boolean>
  startResizeLeft(/* 左栏按下时的视口横坐标。 */ startX: number): void
  startResizeRight(/* 右栏按下时的视口横坐标。 */ startX: number): void
} {
  // 偏好只有显式拖动才更新；宿主变化只重新投影有效尺寸。
  const startResize = useMouseResize()
  const saved = loadWidths(defaults)
  const preferred = ref(saved)
  const containerWidth = ref(0)
  const compact = computed(() => containerWidth.value > 0 && containerWidth.value <= 700)
  const sideBudget = computed(() => compact.value || containerWidth.value === 0 ? Infinity
    : containerWidth.value - 200 - (rightVisible.value ? 8 : 4))
  const effective = computed(() => {
    // 先保留左栏偏好，为可见右栏至少留260、中心至少留200像素。
    const left = Math.min(preferred.value.left, Math.max(160, sideBudget.value - (rightVisible.value ? 260 : 0)))
    const right = rightVisible.value ? Math.min(preferred.value.right, Math.max(260, sideBudget.value - left)) : 0
    return { left, right }
  })
  const leftWidth = computed(() => effective.value.left)
  const rightWidth = computed(() => effective.value.right)
  let observer: ResizeObserver | undefined
  onMounted(() => {
    const element = container.value
    if (!element) return
    const measure = () => { containerWidth.value = element.clientWidth }
    measure()
    observer = new ResizeObserver(measure)
    observer.observe(element)
  })
  onScopeDispose(() => observer?.disconnect())

  function persist() {
    // 将当前左右栏宽度一起写入浏览器存储。
    saveWidths({ ...preferred.value })
  }

  /**
   * 记录左栏初始宽度并安装拖动监听。
   *
   * @param startX 左栏拖动按下时的视口横坐标，单位为 CSS 像素。
   */
  function startResizeLeft(startX: number) {
    if (compact.value) return
    const startWidth = leftWidth.value
    /**
     * 按水平拖动距离调整左栏宽度，限制在 160–400 像素。
     *
     * @param e 窗口鼠标移动事件，其横向位移决定左栏宽度增量。
     */
    function onMove(e: MouseEvent) {
      const max = Math.min(400, sideBudget.value - (rightVisible.value ? 260 : 0))
      preferred.value = { ...preferred.value, left: Math.min(max, Math.max(160, startWidth + e.clientX - startX)) }
    }
    startResize(onMove, persist)
  }

  /**
   * 记录右栏初始宽度并安装拖动监听。
   *
   * @param startX 右栏拖动按下时的视口横坐标，单位为 CSS 像素。
   */
  function startResizeRight(startX: number) {
    if (compact.value || !rightVisible.value) return
    const startWidth = rightWidth.value
    /**
     * 按反向水平拖动距离调整右栏宽度，限制在 260–520 像素。
     *
     * @param e 窗口鼠标移动事件，向左的位移增加右栏宽度。
     */
    function onMove(e: MouseEvent) {
      const max = Math.min(520, sideBudget.value - leftWidth.value)
      preferred.value = { ...preferred.value, right: Math.min(max, Math.max(260, startWidth - (e.clientX - startX))) }
    }
    startResize(onMove, persist)
  }


  return { leftWidth, rightWidth, compact, startResizeLeft, startResizeRight }
}
