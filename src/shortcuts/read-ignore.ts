export function shortcutIsRunContinue(ev: KeyboardEvent): boolean {
  if (ev.key !== 'Enter') return false
  const mod = /Mac|iPhone|iPod|iPad/i.test(navigator.platform)
    ? ev.metaKey
    : ev.ctrlKey
  return mod && !ev.altKey && !ev.shiftKey
}

export function shortcutReadContextMenuOpen(): boolean {
  return !!document.querySelector('.sidebar-context-menu, .canvas-context-menu')
}

export function shortcutReadIgnore(ev: KeyboardEvent): boolean {
  if (shortcutIsRunContinue(ev)) return false
  const el = ev.target as HTMLElement
  if (el.closest('input, textarea, select, [contenteditable]')) return true
  if (shortcutReadContextMenuOpen()) return true
  return false
}
