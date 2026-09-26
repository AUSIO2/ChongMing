import { ref } from 'vue'

const STORAGE_KEY = 'chongming.bottomDockHeight'
const MIN_HEIGHT = 72
const MAX_HEIGHT = 420
const DEFAULT_HEIGHT = 132

// 用途：处理界面相关工作，并把结果交给调用方。
function loadHeight(): number {
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

// 用途：处理界面相关工作，并把结果交给调用方。
function saveHeight(height: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(height))
  } catch {
    /* ignore */
  }
}

// 用途：处理界面相关工作，并把结果交给调用方。
export function useBottomDockResize() {
  const dockHeight = ref(loadHeight())

  // 用途：处理界面相关工作，并把结果交给调用方。
  function startResizeBottom(startY: number) {
    const startHeight = dockHeight.value
    // 用途：处理界面相关工作，并把结果交给调用方。
    function onMove(e: MouseEvent) {
      const max = Math.min(MAX_HEIGHT, Math.floor(window.innerHeight * 0.45))
      dockHeight.value = Math.min(
        max,
        Math.max(MIN_HEIGHT, startHeight + (startY - e.clientY)),
      )
    }
    // 用途：处理界面相关工作，并把结果交给调用方。
    function onUp() {
      saveHeight(dockHeight.value)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return { dockHeight, startResizeBottom }
}
