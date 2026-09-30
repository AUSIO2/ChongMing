// 底部面板尺寸：按窗口空间约束拖动高度，并持久化布局偏好。
import { ref } from 'vue'

const STORAGE_KEY = 'chongming.bottomDockHeight'
const MIN_HEIGHT = 72
const MAX_HEIGHT = 420
const DEFAULT_HEIGHT = 132

function loadHeight(): number {
  // 恢复已保存的底部面板高度并限制范围；缺失或读取失败时使用默认高度。
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_HEIGHT
    const n = Number(raw)
    if (!Number.isFinite(n)) return DEFAULT_HEIGHT
    return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n))
  } catch {
    return DEFAULT_HEIGHT
  }
}

/**
 * 保存底部面板高度；存储不可用时保留本次界面的调整结果。
 *
 * @param height 拖动结束后的面板高度，单位为 CSS 像素。
 */
function saveHeight(height: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(height))
  } catch {
    /* 浏览器存储不可用时仍保留本次布局调整。 */
  }
}

export function useBottomDockResize() {
  // 持有底部面板高度，提供拖动调整与结束后保存的操作。
  const dockHeight = ref(loadHeight())

  /**
   * 记录拖动起始高度，并安装窗口级鼠标移动和松开监听。
   *
   * @param startY 分隔条按下时的视口纵坐标，单位为 CSS 像素。
   */
  function startResizeBottom(startY: number) {
    const startHeight = dockHeight.value
    /**
     * 按向上拖动距离增加面板高度，同时限制最大值不超过窗口高度的 45%。
     *
     * @param e 窗口派发的拖动事件，用纵坐标与起点之差调整面板高度。
     */
    function onMove(e: MouseEvent) {
      const max = Math.min(MAX_HEIGHT, Math.floor(window.innerHeight * 0.45))
      dockHeight.value = Math.min(
        max,
        Math.max(MIN_HEIGHT, startHeight + (startY - e.clientY)),
      )
    }
    function onUp() {
      // 保存最终高度，并移除本次拖动的窗口监听。
      saveHeight(dockHeight.value)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return { dockHeight, startResizeBottom }
}
