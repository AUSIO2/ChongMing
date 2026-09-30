<!-- 竖向分隔条：向父组件提供水平拖动起点并管理拖动时的文本选择。 -->
<script setup lang="ts">
defineProps<{
  side: 'left' | 'right'
}>()

const emit = defineEmits<{
  dragStart: [clientX: number]
}>()

/**
 * 阻止拖动时选中文本，并向父组件发送侧栏拖动起点。
 *
 * @param e 来自竖向分隔条的鼠标按下事件，clientX 提供视口像素起点。
 */
function onMouseDown(e: MouseEvent) {
  e.preventDefault()
  document.body.style.userSelect = 'none'
  emit('dragStart', e.clientX)
  const onUp = () => {
    // 鼠标松开后恢复文本选择并移除本次拖动监听。
    document.body.style.userSelect = ''
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <!-- 分隔条只发送拖动起点，实际宽度由父组件维护。 -->
  <div
    class="split"
    :class="side"
    @mousedown="onMouseDown"
  />
</template>

<style scoped>
/* 为左右栏提供窄幅可命中的拖动区和悬停提示。 */
.split {
  flex-shrink: 0;
  width: 4px;
  cursor: col-resize;
  background: var(--border-subtle);
  transition: background 0.1s;
}

.split:hover {
  background: var(--accent);
}
</style>
