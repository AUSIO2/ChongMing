<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import PanelRegion from './shell/PanelRegion.vue'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()
const { newsList, currentNewsId, loading } = storeToRefs(store)

onMounted(() => store.loadNewsList())

function preview(content: string) {
  return content.length > 36 ? `${content.slice(0, 36)}…` : content
}
</script>

<template>
  <PanelRegion title="新闻" class="sidebar">
    <template #actions>
      <button class="primary" :disabled="loading" @click="store.createSampleNews()">
        + 演示案例
      </button>
    </template>

    <ul v-if="newsList.length" class="news-list">
      <li
        v-for="item in newsList"
        :key="item._id"
        :class="{ active: item._id === currentNewsId }"
        @click="store.selectNews(item._id)"
      >
        <p class="preview">{{ preview(item.content) }}</p>
        <span class="meta">{{ item.claimCount }} 条</span>
      </li>
    </ul>
    <p v-else class="empty">暂无新闻</p>
  </PanelRegion>
</template>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.sidebar :deep(.panel-region-head) {
  gap: var(--space-sm);
}

.news-list {
  list-style: none;
}

.news-list li {
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  min-height: 28px;
}

.news-list li:hover {
  background: var(--bg-hover);
}

.news-list li.active {
  background: var(--bg-hover);
  border-left: 3px solid var(--accent);
  padding-left: calc(var(--space-md) - 3px);
}

.preview {
  font-size: var(--ui-font-size-md);
  line-height: 1.35;
  margin-bottom: 1px;
}

.meta {
  font-size: var(--ui-font-size);
  color: var(--text-dim);
}

.empty {
  padding: var(--space-md);
  color: var(--text-dim);
}
</style>
