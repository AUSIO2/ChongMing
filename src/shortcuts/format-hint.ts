import { uiReadIsMac } from '../shared/platform'

export function shortcutFormatRunContinueHint(): string {
  return uiReadIsMac() ? '⌘↵' : 'Ctrl+Enter'
}
