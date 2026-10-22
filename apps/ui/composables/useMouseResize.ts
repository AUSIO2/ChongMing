// 一次面板拖动持有窗口监听；正常松开保存，作用域结束只撤销未完成的拖动。
import { onScopeDispose } from 'vue'

export function useMouseResize(): (
  /* 当前拖动对窗口鼠标坐标的更新操作。 */ onMove: (/* 本次窗口派发的鼠标移动。 */ event: MouseEvent) => void,
  /* 正常松开后保存最终尺寸；卸载取消时不执行。 */ onFinish: () => void,
) => void {
  // 当前组件作用域最多拥有一次拖动，新拖动与卸载都会先清理旧监听。
  let cancel: (() => void) | null = null
  onScopeDispose(() => {
    // 组件卸载后不再修改尺寸或写入上一视图的布局。
    cancel?.()
  })
  return function startResize(
    /* 当前拖动对窗口鼠标坐标的更新操作。 */ onMove: (/* 本次窗口派发的鼠标移动。 */ event: MouseEvent) => void,
    /* 正常结束后的尺寸持久化操作。 */ onFinish: () => void,
  ): void {
    // 监听和文本选择状态一同交给本次拖动，取消不会被当作正常保存。
    cancel?.()
    const previousUserSelect = document.body.style.userSelect
    function move(event: MouseEvent): void {
      // 窗口外松开主键时即使遗漏mouseup，也不继续响应普通鼠标移动。
      if ((event.buttons & 1) === 0) { cleanup(); return }
      onMove(event)
    }
    function cleanup(): void {
      // 移除本次监听并归还文本选择，随后可开始新的拖动。
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', finish)
      window.removeEventListener('blur', cleanup)
      document.body.style.userSelect = previousUserSelect
      cancel = null
    }
    function finish(): void {
      // 正常松开先交还窗口资源，再持久化已完成的尺寸。
      cleanup()
      onFinish()
    }
    cancel = cleanup
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', finish)
    window.addEventListener('blur', cleanup)
  }
}
