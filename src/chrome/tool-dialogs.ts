import { ref } from 'vue'

export type ToolDialogKind = 'dedup' | 'batch-subagent' | 'batch-priority'

export const toolDialogOpen = ref<ToolDialogKind | null>(null)

export function toolOpenDialog(kind: ToolDialogKind) {
  toolDialogOpen.value = kind
}

export function toolCloseDialog() {
  toolDialogOpen.value = null
}
