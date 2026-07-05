<script setup lang="ts">
const emit = defineEmits<{
  dragStart: [clientY: number]
}>()

function onMouseDown(e: MouseEvent) {
  e.preventDefault()
  document.body.style.userSelect = 'none'
  emit('dragStart', e.clientY)
  const onUp = () => {
    document.body.style.userSelect = ''
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <div class="row-split" @mousedown="onMouseDown" />
</template>

<style scoped>
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
