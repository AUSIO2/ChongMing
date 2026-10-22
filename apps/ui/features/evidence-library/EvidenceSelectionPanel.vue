<!-- 核查表单的只读候选选择，不默认使用整个证据库。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { EvidenceSelection } from './evidence-selection'
import { evidenceReadJudgment } from './evidence-presentation'
const props = defineProps<{ selection: EvidenceSelection; disabled: boolean; description?: string }>()
const selectedIds = computed(() => /* 当前显式选择用于候选勾选和容量禁用，不依赖当前页次。 */
  new Set(props.selection.selected.value.map((/* 已确认条目。 */ item) => /* 以entry身份关联候选。 */ item.id)))
</script>

<template>
  <fieldset class="library-selection" :disabled="disabled">
    <legend>证据库材料 · 可选</legend>
    <p>{{ description ?? '显式选中的固定版本将在开始核查时冻结。' }}已选 {{ selection.selected.value.length }}/32 条。</p>
    <div class="search-row"><label>关键词<input v-model="selection.browser.filters.value.query" type="search" placeholder="检索库陈述"></label><label>固定判断<select v-model="selection.browser.filters.value.confidence"><option value="all">全部</option><option value="0">0 · 确定错误</option><option value="1">1 · 确定正确</option></select></label><button type="button" :disabled="selection.browser.loading.value" @click="selection.browser.search()">检索材料</button></div>
    <p v-if="selection.browser.error.value" class="error" role="alert">{{ selection.browser.error.value.message }}</p>
    <p v-if="selection.browser.loading.value" role="status">正在读取候选…</p>
    <div class="candidate-list"><label v-for="item in selection.browser.items.value" :key="item.id" class="candidate"><input type="checkbox" :checked="selectedIds.has(item.id)" :disabled="!selectedIds.has(item.id) && selection.selected.value.length >= 32" @change="selection.toggle(item)"><span><small>{{ evidenceReadJudgment(item.confidence) }}</small><span>{{ item.content }}</span></span></label></div>
    <button v-if="selection.browser.nextCursor.value" type="button" :disabled="selection.browser.loading.value" @click="selection.browser.loadMore()">加载更多材料</button>
    <div v-if="selection.selected.value.length" class="selected-list"><strong>已选固定材料</strong><button v-for="item in selection.selected.value" :key="item.id" type="button" @click="selection.toggle(item)">{{ item.content }} · 移除</button></div>
  </fieldset>
</template>

<style scoped>
.library-selection{display:grid;gap:9px;padding:12px;border:1px solid var(--border);border-radius:var(--radius)}legend{font-size:12px;font-weight:650}p{color:var(--text-muted);font-size:11px;line-height:1.7}.search-row{display:flex;align-items:flex-end;gap:7px}.search-row label{display:grid;gap:5px;flex:1;font-size:11px}.search-row input,.search-row select{padding:5px;font-size:11px}.search-row button{flex:none;padding:5px 7px;font-size:11px}.candidate-list{display:grid;gap:7px;max-height:170px;overflow:auto}.candidate{display:flex;gap:8px;align-items:flex-start;padding:7px;background:var(--bg-related);font-size:12px;line-height:1.6}.candidate input{width:auto;flex:none;margin-top:4px}.candidate>span{display:grid;gap:2px}.candidate small{color:var(--text-muted)}.selected-list{display:grid;gap:5px}.selected-list strong{font-size:11px}.selected-list button{text-align:left;font-size:11px;overflow-wrap:anywhere}.error{color:var(--danger)}
</style>
