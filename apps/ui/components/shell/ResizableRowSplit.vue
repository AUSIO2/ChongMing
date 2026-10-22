<!-- 横向分隔条：只向持有拖动生命周期的父组件发送垂直起点。 -->
<script setup lang="ts">
const emit = defineEmits<{
  dragStart: [clientY: number]
}>()

/**
 * 阻止原生选择，并向持有拖动生命周期的父组件发送底部面板起点。
 *
 * @param e 来自横向分隔条的鼠标按下事件，clientY 提供视口像素起点。
 */
function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  emit('dragStart', e.clientY)

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
