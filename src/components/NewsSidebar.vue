<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()
const { newsList, currentNewsId, loading } = storeToRefs(store)

onMounted(() => store.loadNewsList())

function preview(content: string) {
  return content.length > 48 ? `${content.slice(0, 48)}…` : content
}
</script>

<template>
  <aside class="sidebar panel">
    <div class="sidebar-head">
      <h2 class="panel-title">新闻列表</h2>
      <button class="primary" :disabled="loading" @click="store.createSampleNews()">
        + 示例
      </button>
    </div>

    <ul v-if="newsList.length" class="news-list">
      <li
        v-for="item in newsList"
        :key="item._id"
        :class="{ active: item._id === currentNewsId }"
        @click="store.selectNews(item._id)"
      >
        <p class="preview">{{ preview(item.content) }}</p>
        <span class="meta">{{ item.claimCount }} 条事实</span>
      </li>
    </ul>
    <p v-else class="empty">暂无新闻，点击「+ 示例」创建</p>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  border-bottom: 1px solid var(--border);
}

.news-list {
  list-style: none;
  overflow-y: auto;
  flex: 1;
}

.news-list li {
  padding: 0.75rem;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}

.news-list li:hover {
  background: #f3f4f6;
}

.news-list li.active {
  background: #eff6ff;
  border-left: 3px solid var(--primary);
}

.preview {
  font-size: 0.875rem;
  line-height: 1.4;
  margin-bottom: 0.25rem;
}

.meta {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.empty {
  padding: 1rem;
  color: var(--text-muted);
  font-size: 0.875rem;
}
</style>
