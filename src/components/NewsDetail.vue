<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()
const { currentNews, selectedClaimId } = storeToRefs(store)

const contextRows = computed(() => {
  if (!currentNews.value) return []
  return Object.entries(currentNews.value.context).map(([key, field]) => ({
    key,
    value: field ? String(field.value) : '',
    visible: field?.visibleToAI ?? false,
  }))
})

function scoreClass(score?: number) {
  if (score === 1) return 'score-1'
  if (score === 0) return 'score-0'
  return 'score-0_5'
}
</script>

<template>
  <section v-if="currentNews" class="detail">
    <div class="panel section">
      <h2 class="panel-title">上下文</h2>
      <table>
        <thead>
          <tr>
            <th>字段</th>
            <th>值</th>
            <th>AI 可见</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in contextRows" :key="row.key">
            <td>{{ row.key }}</td>
            <td>{{ row.value }}</td>
            <td>{{ row.visible ? '是' : '否' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel section">
      <h2 class="panel-title">正文</h2>
      <article class="content">{{ currentNews.content }}</article>
    </div>

    <div class="panel section">
      <h2 class="panel-title">拆分事实 ({{ currentNews.claims.length }})</h2>
      <ul v-if="currentNews.claims.length" class="claims">
        <li
          v-for="claim in currentNews.claims"
          :key="claim.claimId"
          :class="{ selected: claim.claimId === selectedClaimId }"
          @click="store.selectedClaimId = claim.claimId"
        >
          <div class="claim-head">
            <span class="claim-id">#{{ claim.claimId }}</span>
            <span v-if="claim.category" class="tag">{{ claim.category }}</span>
            <span
              v-if="claim.verifyResult"
              :class="scoreClass(claim.verifyResult.score)"
            >
              {{ claim.verifyResult.score }}
            </span>
          </div>
          <p>{{ claim.content }}</p>
        </li>
      </ul>
      <p v-else class="empty">尚未拆分，请在右侧启动拆分流程</p>
    </div>
  </section>
  <section v-else class="detail empty-state panel">
    <p>← 从左侧选择或创建一条新闻</p>
  </section>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
}

.section {
  padding: 0.75rem;
}

.content {
  font-family: var(--content-font);
  line-height: 1.7;
  font-size: 0.9375rem;
  white-space: pre-wrap;
}

.claims {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.claims li {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.625rem;
  cursor: pointer;
}

.claims li.selected {
  border-color: var(--primary);
  background: #eff6ff;
}

.claim-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
  font-size: 0.75rem;
}

.claim-id {
  font-weight: 600;
}

.tag {
  background: #f3f4f6;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
}

.claims p {
  font-size: 0.875rem;
  line-height: 1.5;
}

.empty,
.empty-state {
  color: var(--text-muted);
  font-size: 0.875rem;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  margin: 0.75rem;
}
</style>
