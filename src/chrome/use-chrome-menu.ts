import { onMounted, onUnmounted, ref } from 'vue'
import { chromeDispatchAndClose } from './chrome-dispatch'
import type { ChromeMenuAction, ChromePopupId } from './types'

const openPopupId = ref<ChromePopupId | null>(null)
const toastMessage = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function chromeReadOpenMenu(): typeof openPopupId {
  return openPopupId
}

export function chromeReadToast(): typeof toastMessage {
  return toastMessage
}

export function chromeToggleMenu(id: ChromePopupId) {
  openPopupId.value = openPopupId.value === id ? null : id
}

export function chromeCloseMenu() {
  openPopupId.value = null
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
    if (
      target.closest('.chrome-menu-bar')
      || target.closest('.chrome-menu-dropdown')
      || target.closest('.workspace-picker')
    ) {
      return
    }
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
