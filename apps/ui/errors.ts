import type { App } from 'vue'
import type { Router } from 'vue-router'

// 用途：处理界面相关工作，并把结果交给调用方。
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
    panel.querySelector('button')!.addEventListener('click', () => location.reload())
    document.body.append(panel)
  }
  panel.querySelector('[data-error-id]')!.textContent = `错误编号：${errorId}`
}

// 用途：处理界面相关工作，并把结果交给调用方。
export function uiRegisterErrors(app: App, router: Router): () => void {
  let showing = false
  const show = (source: 'vue' | 'window' | 'promise' | 'router') => { if (!showing) { showing = true; uiShowFailure(source) } }
  app.config.errorHandler = () => show('vue')
  const error = () => show('window')
  const rejection = (event: PromiseRejectionEvent) => { event.preventDefault(); show('promise') }
  window.addEventListener('error', error)
  window.addEventListener('unhandledrejection', rejection)
  const removeRouter = router.onError(() => show('router'))
  return () => { window.removeEventListener('error', error); window.removeEventListener('unhandledrejection', rejection); removeRouter() }
}
