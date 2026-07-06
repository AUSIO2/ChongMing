import { onMounted, onUnmounted, ref } from 'vue'
import { chromeDispatchAndClose } from './chrome-dispatch'
import type { ChromeMenuAction, ChromeMenuId } from './types'

const openMenuId = ref<ChromeMenuId | null>(null)
const toastMessage = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function chromeReadOpenMenu(): typeof openMenuId {
  return openMenuId
}

export function chromeReadToast(): typeof toastMessage {
  return toastMessage
}

export function chromeToggleMenu(id: ChromeMenuId) {
  openMenuId.value = openMenuId.value === id ? null : id
}

export function chromeCloseMenu() {
  openMenuId.value = null
}

export function chromeShowToast(message: string) {
  toastMessage.value = message
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = null
    toastTimer = null
  }, 2400)
}

export function chromeRunAction(action: ChromeMenuAction) {
  chromeDispatchAndClose(action)
}

export function useChromeMenuDismiss() {
  function onKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') chromeCloseMenu()
  }

  function onPointerDown(ev: Event) {
    const target = ev.target as Element
    if (target.closest('.chrome-menu-bar') || target.closest('.chrome-menu-dropdown')) return
    chromeCloseMenu()
  }

  onMounted(() => {
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('pointerdown', onPointerDown)
  })
}
