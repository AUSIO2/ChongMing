import { ref } from 'vue'

const mapSidebarExpanded = ref(true)

export function useMapSidebar() {
  return { mapSidebarExpanded }
}
