import { ref } from 'vue'

export const agentManagerPendingCreate = ref(false)

export function agentManagerRequestCreate() {
  agentManagerPendingCreate.value = true
}
