import { onMounted, onUnmounted, type MaybeRefOrGetter, toValue } from 'vue'
import type { LayoutNavDir } from '../flow-map/layout-nav'
import { useFlowMapStore } from '../stores/flow-map'
import { shortcutIsRunContinue, shortcutReadIgnore } from './read-ignore'

const ARROW_DIR: Record<string, LayoutNavDir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

export function useAppShortcuts(enabled: MaybeRefOrGetter<boolean> = true) {
  const flowMap = useFlowMapStore()

  function onKeyDown(ev: KeyboardEvent) {
    if (!toValue(enabled)) return
    if (shortcutIsRunContinue(ev)) {
      ev.preventDefault()
      void flowMap.runOrContinuePrimary()
      return
    }

    if (shortcutReadIgnore(ev)) return

    const dir = ARROW_DIR[ev.key]
    if (!dir) return

    ev.preventDefault()
    flowMap.selectLayoutNeighbor(dir)
  }

  onMounted(() => {
    document.addEventListener('keydown', onKeyDown)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', onKeyDown)
  })
}
