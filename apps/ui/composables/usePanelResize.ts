// 左右侧栏尺寸：按拖动调整宽度并恢复、保存浏览器中的布局偏好。
import { onMounted, onUnmounted, ref } from 'vue'

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
      left: parsed.left ?? defaults.left,
      right: parsed.right ?? defaults.right,
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
 * @param defaults 没有已保存偏好时的像素宽度；默认左栏 200、右栏 320，不修改传入对象。
 */
export function usePanelResize(defaults: PanelWidths = { left: 200, right: 320 }) {
  const leftWidth = ref(loadWidths(defaults).left)
  const rightWidth = ref(loadWidths(defaults).right)

  function persist() {
    // 将当前左右栏宽度一起写入浏览器存储。
    saveWidths({ left: leftWidth.value, right: rightWidth.value })
  }

  /**
   * 记录左栏初始宽度并安装拖动监听。
   *
   * @param startX 左栏拖动按下时的视口横坐标，单位为 CSS 像素。
   */
  function startResizeLeft(startX: number) {
    const startWidth = leftWidth.value
    /**
     * 按水平拖动距离调整左栏宽度，限制在 160–400 像素。
     *
     * @param e 窗口鼠标移动事件，其横向位移决定左栏宽度增量。
     */
    function onMove(e: MouseEvent) {
      leftWidth.value = Math.min(400, Math.max(160, startWidth + e.clientX - startX))
    }
    function onUp() {
      // 保存左栏拖动结果并移除窗口鼠标监听。
      persist()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /**
   * 记录右栏初始宽度并安装拖动监听。
   *
   * @param startX 右栏拖动按下时的视口横坐标，单位为 CSS 像素。
   */
  function startResizeRight(startX: number) {
    const startWidth = rightWidth.value
    /**
     * 按反向水平拖动距离调整右栏宽度，限制在 260–520 像素。
     *
     * @param e 窗口鼠标移动事件，向左的位移增加右栏宽度。
     */
    function onMove(e: MouseEvent) {
      rightWidth.value = Math.min(520, Math.max(260, startWidth - (e.clientX - startX)))
    }
    function onUp() {
      // 保存右栏拖动结果并移除窗口鼠标监听。
      persist()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  onMounted(() => {
    // 组件挂载时恢复正文的默认文本选择行为。
    document.body.style.userSelect = ''
  })

  onUnmounted(() => {
    // 组件卸载时恢复正文的默认文本选择行为。
    document.body.style.userSelect = ''
  })

  return { leftWidth, rightWidth, startResizeLeft, startResizeRight }
}
