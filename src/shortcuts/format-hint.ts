const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPod|iPad/i.test(navigator.platform)

export function shortcutFormatRunContinueHint(): string {
  return IS_MAC ? '⌘↵' : 'Ctrl+Enter'
}
