// 界面错误边界：统一记录未处理异常并展示带诊断编号的恢复入口。
import type { App } from 'vue'
import type { Router } from 'vue-router'

/**
 * 上报带诊断编号的界面错误，并建立或更新可重新加载页面的全局错误面板。
 *
 * @param source 异常入口类别，随诊断编号传给桌面进程，不包含原始异常正文。
 */
function uiShowFailure(source: 'vue' | 'window' | 'promise' | 'router'): void {
  const errorId = crypto.randomUUID()
  window.chongmingClient?.reportError({ errorId, source })
  let panel = document.getElementById('global-error')
  if (!panel) {
    panel = document.createElement('section')
    panel.id = 'global-error'
    panel.setAttribute('role', 'alert')
    panel.style.cssText = 'position:fixed;inset:20px;z-index:9999;margin:auto;max-width:520px;height:max-content;padding:24px;background:#fff;border:1px solid #b75b44;box-shadow:0 12px 50px #0003;font:14px/1.6 system-ui;color:#442820'
    panel.innerHTML = '<h1 style="font-size:18px;margin:0 0 10px">界面发生错误</h1><p>业务数据仍保存在服务中。重新打开界面会从已保存的节点状态恢复。</p><p data-error-id></p><button type="button" style="margin-top:12px;padding:7px 14px">重新打开界面</button>'
    panel.querySelector('button')!.addEventListener('click', () => /* 重新加载页面，从服务中恢复已保存的状态。 */ location.reload())
    document.body.append(panel)
  }
  panel.querySelector('[data-error-id]')!.textContent = `错误编号：${errorId}`
}

/**
 * 注册 Vue、窗口、Promise 和路由错误边界，并返回窗口与路由监听的清理函数。
 *
 * @param app 正在启动的 Vue 应用实例，本函数会设置其全局错误处理器。
 * @param router 应用路由实例，用于注册并返回可移除的路由错误监听。
 */
export function uiRegisterErrors(
  app: App,
  router: Router
): () => void {
  let showing = false
  /**
   * 只在首次未处理错误时展示全局错误面板。
   *
   * @param source 首次触发错误的入口类别，用于统一错误面板和诊断上报。
   */
  const show = (source: 'vue' | 'window' | 'promise' | 'router') => {
    if (!showing) { showing = true; uiShowFailure(source) }
  }
  app.config.errorHandler = () => /* 把 Vue 组件异常交给统一错误展示入口。 */ show('vue')
  const error = () => /* 把窗口运行时异常交给统一错误展示入口。 */ show('window')
  /**
   * 阻止未处理拒绝的默认展示，并显示带诊断编号的错误面板。
   *
   * @param event 浏览器派发的未处理 Promise 拒绝事件，本函数会阻止其默认处理。
   */
  const rejection = (event: PromiseRejectionEvent) => {
    event.preventDefault(); show('promise')
  }
  window.addEventListener('error', error)
  window.addEventListener('unhandledrejection', rejection)
  const removeRouter = router.onError(() => /* 把路由异常交给统一错误展示入口。 */ show('router'))
  return () => {
    // 移除窗口错误、Promise 拒绝和路由错误监听。
    window.removeEventListener('error', error); window.removeEventListener('unhandledrejection', rejection); removeRouter()
  }
}
