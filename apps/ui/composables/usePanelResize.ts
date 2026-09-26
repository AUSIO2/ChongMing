import { onMounted, onUnmounted, ref } from 'vue'

const STORAGE_KEY = 'chongming.panelWidths'

interface PanelWidths {
  left: number
  right: number
}

// 用途：处理界面相关工作，并把结果交给调用方。
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

// 用途：处理界面相关工作，并把结果交给调用方。
function saveWidths(widths: PanelWidths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths))
  } catch {
    /* ignore */
  }
}

// 用途：处理界面相关工作，并把结果交给调用方。
export function usePanelResize(defaults: PanelWidths = { left: 200, right: 320 }) {
  const leftWidth = ref(loadWidths(defaults).left)
  const rightWidth = ref(loadWidths(defaults).right)

  // 用途：处理界面相关工作，并把结果交给调用方。
  function persist() {
    saveWidths({ left: leftWidth.value, right: rightWidth.value })
  }

  // 用途：处理界面相关工作，并把结果交给调用方。
  function startResizeLeft(startX: number) {
    const startWidth = leftWidth.value
    // 用途：处理界面相关工作，并把结果交给调用方。
    function onMove(e: MouseEvent) {
      leftWidth.value = Math.min(400, Math.max(160, startWidth + e.clientX - startX))
    }
    // 用途：处理界面相关工作，并把结果交给调用方。
    function onUp() {
      persist()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 用途：处理界面相关工作，并把结果交给调用方。
  function startResizeRight(startX: number) {
    const startWidth = rightWidth.value
    // 用途：处理界面相关工作，并把结果交给调用方。
    function onMove(e: MouseEvent) {
      rightWidth.value = Math.min(520, Math.max(260, startWidth - (e.clientX - startX)))
    }
    // 用途：处理界面相关工作，并把结果交给调用方。
    function onUp() {
      persist()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  onMounted(() => {
    document.body.style.userSelect = ''
  })

  onUnmounted(() => {
    document.body.style.userSelect = ''
  })

  return { leftWidth, rightWidth, startResizeLeft, startResizeRight }
}
