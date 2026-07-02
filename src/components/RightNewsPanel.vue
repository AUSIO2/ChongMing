<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import PanelRegion from './shell/PanelRegion.vue'
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
  <div class="right-news">
    <template v-if="currentNews">
      <PanelRegion title="上下文" class="section">
        <table v-if="contextRows.length">
          <tbody>
            <tr v-for="row in contextRows" :key="row.key">
              <th>{{ row.key }}</th>
              <td>{{ row.value }}</td>
              <td>{{ row.visible ? '是' : '否' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty">无上下文</p>
      </PanelRegion>

      <PanelRegion title="正文" class="section content-section">
        <article class="content">{{ currentNews.content }}</article>
      </PanelRegion>

      <PanelRegion :title="`事实 (${currentNews.claims.length})`" class="section claims-section">
        <p v-if="store.isSelectingClaims" class="select-hint">
          勾选要核查的事实，然后点击底部「继续核查」
        </p>
        <ul v-if="currentNews.claims.length" class="claims">
          <li
            v-for="claim in currentNews.claims"
            :key="claim.claimId"
            :class="{ selected: claim.claimId === selectedClaimId }"
            @click="store.selectedClaimId = claim.claimId"
          >
            <div class="claim-head">
              <input
                v-if="store.isSelectingClaims"
                type="checkbox"
                :checked="store.claimsToVerify.includes(claim.claimId)"
                @click.stop
                @change="store.toggleClaimToVerify(claim.claimId)"
              >
              <span class="claim-id">#{{ claim.claimId }}</span>
              <span v-if="claim.category" class="tag">{{ claim.category }}</span>
              <span
                v-if="claim.verifyResult"
                :class="scoreClass(claim.verifyResult.score)"
              >
                {{ claim.verifyResult.score }}
              </span>
            </div>
            <p class="claim-text">{{ claim.content }}</p>
          </li>
        </ul>
        <p v-else class="empty">尚未拆分，请启动流程</p>
      </PanelRegion>
    </template>
    <p v-else class="placeholder">← 从左侧选择新闻</p>
  </div>
</template>

<style scoped>
.right-news {
  flex: 0 0 auto;
  min-height: 0;
  overflow: hidden;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

/* 仅当正文或事实展开时才占用侧栏弹性高度，避免全部折叠后留出大块空白 */
.right-news:has(.content-section:not(.collapsed)),
.right-news:has(.claims-section:not(.collapsed)) {
  flex: 3 1 0;
}

/* 上下文：展开时仅占内容高度 */
.right-news :deep(.panel-region.section:not(.content-section):not(.claims-section)) {
  flex: 0 0 auto;
}

/* 正文、事实：展开时分摊新闻区剩余高度 */
.right-news :deep(.panel-region.content-section:not(.collapsed)) {
  flex: 1 1 0;
  min-height: 88px;
}

.right-news :deep(.panel-region.claims-section:not(.collapsed)) {
  flex: 1.35 1 0;
  min-height: 112px;
}

.right-news :deep(.panel-region.content-section:not(.collapsed)),
.right-news :deep(.panel-region.claims-section:not(.collapsed)) {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.right-news :deep(.panel-region.content-section:not(.collapsed) .panel-region-body),
.right-news :deep(.panel-region.claims-section:not(.collapsed) .panel-region-body) {
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}

.section {
  border-bottom: 1px solid var(--border-subtle);
}

.content {
  padding: var(--space-md);
  font-family: var(--content-font);
  font-size: var(--ui-font-size-lg);
  line-height: 1.55;
  white-space: pre-wrap;
}

.claims {
  list-style: none;
}

.claims li {
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
}

.claims li:hover {
  background: var(--bg-hover);
}

.claims li.selected {
  background: var(--bg-hover);
  border-left: 3px solid var(--accent);
  padding-left: calc(var(--space-md) - 3px);
}

.select-hint {
  padding: var(--space-sm) var(--space-md);
  font-size: var(--ui-font-size);
  color: var(--warning);
  background: #fff8ee;
  border-bottom: 1px solid var(--border-subtle);
}

.claim-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: 2px;
  font-size: var(--ui-font-size);
}

.claim-head input[type="checkbox"] {
  width: auto;
  margin: 0;
}

.claim-id {
  font-weight: 600;
}

.tag {
  background: var(--bg-header);
  padding: 0 4px;
  border-radius: var(--radius);
  font-size: var(--ui-font-size);
}

.claim-text {
  font-size: var(--ui-font-size-md);
  line-height: 1.4;
  color: var(--text-muted);
}

.empty,
.placeholder {
  padding: var(--space-md);
  color: var(--text-dim);
  font-size: var(--ui-font-size-md);
}

.placeholder {
  text-align: center;
  padding: 1.5rem var(--space-md);
}

table {
  margin: var(--space-sm);
  width: calc(100% - var(--space-md) * 2);
}
</style>
