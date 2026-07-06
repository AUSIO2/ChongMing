<script setup lang="ts">
import { ref, watch } from 'vue'
import type { ClaimCategory, PromptKind } from '../../../electron/api/types'

const props = defineProps<{
  kind: PromptKind
  claimCategory?: ClaimCategory
}>()

const preview = ref('')

async function loadPreview() {
  preview.value = await window.electronAPI?.agentRegistry.previewOutput(
    props.kind,
    props.claimCategory ? { claimCategory: props.claimCategory } : undefined,
  ) ?? ''
}

watch(
  () => [props.kind, props.claimCategory] as const,
  () => { void loadPreview() },
  { immediate: true },
)
</script>

<template>
  <div class="prompt-output-preview">
    <span class="label">返回格式（自动生成）</span>
    <pre class="preview">{{ preview }}</pre>
  </div>
</template>

<style scoped>
.prompt-output-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-sm);
  font-size: var(--ui-font-size-sm);
}

.label {
  font-weight: 500;
}

.preview {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-viewport);
  color: var(--text-muted);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  max-height: 180px;
  overflow: auto;
}
</style>
