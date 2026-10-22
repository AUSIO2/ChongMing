<!-- 竖向分隔条：只向持有拖动生命周期的父组件发送水平起点。 -->
<script setup lang="ts">
defineProps<{
  side: 'left' | 'right'
}>()

const emit = defineEmits<{
  dragStart: [clientX: number]
}>()

/**
 * 阻止原生选择，并向持有拖动生命周期的父组件发送侧栏起点。
 *
 * @param e 来自竖向分隔条的鼠标按下事件，clientX 提供视口像素起点。
 */
function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  emit('dragStart', e.clientX)

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
