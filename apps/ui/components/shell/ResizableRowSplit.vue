<!-- 横向分隔条：向父组件提供垂直拖动起点并管理拖动时的文本选择。 -->
<script setup lang="ts">
const emit = defineEmits<{
  dragStart: [clientY: number]
}>()

function onMouseDown(/* 来自横向分隔条的鼠标按下事件，clientY 提供视口像素起点。 */ e: MouseEvent) {
  // 阻止拖动时选中文本，并向父组件发送底部面板拖动起点。
  e.preventDefault()
  document.body.style.userSelect = 'none'
  emit('dragStart', e.clientY)
  const onUp = () => {
    // 鼠标松开后恢复文本选择并移除本次拖动监听。
    document.body.style.userSelect = ''
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <!-- 分隔条只发送拖动起点，实际高度由父组件维护。 -->
  <div class="row-split" @mousedown="onMouseDown" />
</template>

<style scoped>
/* 为底部面板提供可命中的横向拖动区和悬停提示。 */
.row-split {
  flex-shrink: 0;
  height: 4px;
  cursor: row-resize;
  background: var(--border-subtle);
  transition: background 0.1s;
}

.row-split:hover {
  background: var(--accent, #2563eb);
}
</style>
