/** 渲染进程平台判定（菜单快捷键、标题栏等 UI 分支）。 */

export function uiReadIsMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
}

export function uiReadIsWindows(): boolean {
  return typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)
}

/** macOS 使用 hiddenInset 自定义标题区；Win/Linux 用系统标题栏。 */
export function uiReadUsesCustomTitleBar(): boolean {
  return uiReadIsMac()
}
