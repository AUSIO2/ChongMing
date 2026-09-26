<script setup lang="ts">
import { ACTIVITY_LABELS, type GraphActivity } from '../../../../contracts/activity'
import { computed } from 'vue'
import type { CommandInputMap } from '../../../../contracts/client'
import type { GraphSnapshot } from '../../../../contracts/graph'
import OperationReview from './OperationReview.vue'
import { GRAPH_OPERATION_LABELS, graphReadOperationProgress, graphReadRunProgress } from '../graph/graph-layout'

const props = defineProps<{ snapshot: GraphSnapshot; activities?: GraphActivity[]; canEdit: boolean; busy: boolean }>()
const emit = defineEmits<{
  update: [input: CommandInputMap['review.update']]
  answer: [input: CommandInputMap['review.answer']]
  cancel: [input: CommandInputMap['run.cancel']]
  pause: [input: CommandInputMap['run.pause']]
  resume: [input: CommandInputMap['run.resume']]
}>()
const run = computed(() => props.snapshot.run)
const active = computed(() => !!run.value && ['running', 'waiting'].includes(run.value.status))
// 用途：更新界面，并保持相关状态一致。
function reviewUpdateControl(action: 'pause' | 'resume' | 'cancel'): void {
  if (!run.value || !active.value || !props.canEdit || props.busy) return
  const params = { mapId: props.snapshot.mapId, expectedRevision: props.snapshot.revision, runId: run.value.id }
  if (action === 'pause') emit('pause', params)
  else if (action === 'resume') emit('resume', params)
  else emit('cancel', params)
}
</script>

<template>
  <section class="run-panel" aria-label="运行进度与审核">
    <header><h2>处理进度与审核</h2><span v-if="run">{{ run.mode === 'auto' ? '自动处理' : '人工审核' }}</span></header>
    <p v-if="!run" class="run-note">选择来源、新闻或事实开始处理；每个节点的进度和审核会保留在这里。</p>
    <template v-else>
      <div class="run-summary">
        <strong role="status">{{ graphReadRunProgress(run) }}</strong>
        <p>范围 {{ run.scope.nodeIds.length }} 个节点 · {{ { news: '生成新闻', claims: '生成事实', verified: '完成核查' }[run.until] }}</p>
        <p v-if="run.error" class="error" role="alert">{{ run.error.message }}</p>
        <p v-if="run.paused && active" class="run-note">已保存的结果和审核会保留。继续后，从未完成的工作接着处理。</p>
        <div v-if="active && canEdit" class="run-actions">
          <button v-if="run.paused" class="primary" type="button" :disabled="busy" @click="reviewUpdateControl('resume')">继续处理</button>
          <button v-else type="button" :disabled="busy" @click="reviewUpdateControl('pause')">暂停处理</button>
          <button class="cancel" type="button" :disabled="busy" @click="reviewUpdateControl('cancel')">取消本次运行</button>
        </div>
      </div>
      <details v-for="operation in run.operations" :key="`${run.id}:${operation.id}`" class="operation-group" :open="operation.status !== 'completed'">
        <summary><strong>{{ GRAPH_OPERATION_LABELS[operation.kind] }}</strong><span>{{ graphReadOperationProgress(operation) }}</span></summary>
        <ul v-if="!run.paused && activities?.some(item => item.operationId === operation.id)" class="activity-list" aria-label="当前执行活动">
          <li v-for="item in activities.filter(item => item.operationId === operation.id)" :key="item.workId">
            <strong>{{ item.agentName }}</strong> · {{ ACTIVITY_LABELS[item.status] }}
          </li>
        </ul>
        <OperationReview :snapshot="snapshot" :run="run" :operation="operation" :can-edit="canEdit" :busy="busy" @update="emit('update', $event)" @answer="emit('answer', $event)" />
      </details>
    </template>
  </section>
</template>

<style scoped>
.activity-list{padding:0 18px 10px 30px;font-size:12px;line-height:1.8;color:var(--text-muted)}
.operation-group{border-top:1px solid var(--border-subtle)}.operation-group>summary{padding:10px 14px;cursor:pointer;line-height:1.6}.operation-group>summary strong{font-size:12px}.operation-group>summary span{display:block;margin-left:15px;font-size:11px;color:var(--text-muted)}
.run-panel{border-top:1px solid var(--border);background:var(--bg-panel)}header{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px}h2{font-size:14px}header span,.run-summary p{font-size:11px;color:var(--text-muted)}.run-summary{display:grid;gap:9px;padding:0 14px 14px;line-height:1.6}.run-summary>strong{font-size:12px}.run-note{padding:12px 14px;color:var(--text-muted);line-height:1.7}.run-summary .run-note{padding:0}.run-actions{display:flex;gap:8px;flex-wrap:wrap}.cancel,.run-summary .error{color:var(--danger)}
</style>
