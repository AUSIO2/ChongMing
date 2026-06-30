<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import AppHeader from '../components/AppHeader.vue'
import NewsSidebar from '../components/NewsSidebar.vue'
import NewsDetail from '../components/NewsDetail.vue'
import WorkflowPanel from '../components/WorkflowPanel.vue'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()
const hasElectron = typeof window !== 'undefined' && !!window.electronAPI

onMounted(() => {
  if (hasElectron) store.initGraphEvents()
})

onUnmounted(() => store.disposeGraphEvents())
</script>

<template>
  <div class="workspace">
    <AppHeader />
    <div v-if="!hasElectron" class="no-electron panel">
      请在 Electron 环境中运行（<code>npm run dev</code>），浏览器模式无法访问后端 API。
    </div>
    <div v-else class="body">
      <NewsSidebar class="col-sidebar" />
      <NewsDetail class="col-detail" />
      <WorkflowPanel class="col-workflow" />
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.body {
  display: grid;
  grid-template-columns: 220px 1fr 340px;
  flex: 1;
  min-height: 0;
}

.col-sidebar {
  border-right: 1px solid var(--border);
}

.col-workflow {
  border-left: 1px solid var(--border);
}

.no-electron {
  margin: 2rem;
  padding: 1.5rem;
  text-align: center;
  color: var(--text-muted);
}
</style>
