<script setup lang="ts">
defineProps<{
  side: 'left' | 'right'
}>()

const emit = defineEmits<{
  dragStart: [clientX: number]
}>()

function onMouseDown(e: MouseEvent) {
  e.preventDefault()
  document.body.style.userSelect = 'none'
  emit('dragStart', e.clientX)
  const onUp = () => {
    document.body.style.userSelect = ''
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <div
    class="split"
    :class="side"
    @mousedown="onMouseDown"
  />
</template>

<style scoped>
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
