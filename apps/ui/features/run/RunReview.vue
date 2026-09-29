<!-- 运行面板：汇总 Operation 进度和活动，提供暂停、恢复、取消及逐项审核入口。 -->
<script setup lang="ts">
import { ACTIVITY_LABELS, type GraphActivity } from '../../../../contracts/activity'
import { computed } from 'vue'
import type { CommandInputMap } from '../../../../contracts/client'
import type { GraphRun, GraphRunControlGrant, GraphSnapshot } from '../../../../contracts/graph'
import OperationReview from './OperationReview.vue'
import { graphReadOperationLabel, graphReadOperationProgress, graphReadRunProgress } from '../graph/graph-layout'

const props = defineProps<{ snapshot: GraphSnapshot; run: GraphRun | null; activities?: GraphActivity[]; canEdit: boolean; busy: boolean; control: GraphRunControlGrant | null; leasesRequired: boolean }>()
const emit = defineEmits<{
  answer: [input: Omit<CommandInputMap['review.answer'], 'control'>]
  cancel: [input: Omit<CommandInputMap['run.cancel'], 'control'>]
  pause: [input: Omit<CommandInputMap['run.pause'], 'control'>]
  resume: [input: Omit<CommandInputMap['run.resume'], 'control'>]
  claim: []
  release: []
}>()
const run = computed(() => /* 使用会话明确选择的 Run。 */ props.run)
const active = computed(() => /* 判断运行是否仍在执行或等待，暂停中的运行也保留控制入口。 */ !!run.value && ['running', 'waiting'].includes(run.value.status))
const hasControl = computed(() => !!run.value && (!props.leasesRequired || props.control?.runId === run.value.id))
const occupied = computed(() => !!run.value && props.snapshot.runControls.some(control => control.runId === run.value!.id))
function reviewUpdateControl(/* 用户选择的运行控制动作，只接受暂停、恢复或取消。 */ action: 'pause' | 'resume' | 'cancel'): void {
  // 在具备权限且运行未结束时发送暂停、恢复或取消事件。
  if (!run.value || !active.value || !props.canEdit || !hasControl.value || props.busy) return
  const params = { mapId: props.snapshot.mapId, runId: run.value.id }
  if (action === 'pause') emit('pause', params)
  else if (action === 'resume') emit('resume', params)
  else emit('cancel', params)
}
</script>

<template>
  <!-- 运行级控制位于顶部，每个 Operation 展示活动与独立审核组件。 -->
  <section class="run-panel" aria-label="运行进度与审核">
    <header><h2>处理进度与审核</h2><span v-if="run">{{ run.mode === 'auto' ? '自动处理' : '人工审核' }}</span></header>
    <p v-if="!run" class="run-note">选择来源、新闻或事实开始处理；每个节点的进度和审核会保留在这里。</p>
    <template v-else>
      <div class="run-summary">
        <strong role="status">{{ graphReadRunProgress(run) }}</strong>
        <p>范围 {{ run.scope.nodeIds.length }} 个节点 · {{ run.plan.steps.length }} 个转换步骤</p>
        <p v-if="run.error" class="error" role="alert">{{ run.error.message }}</p>
        <p v-if="run.paused && active" class="run-note">已保存的结果和审核会保留。继续后，从未完成的工作接着处理。</p>
        <div v-if="active && canEdit && hasControl" class="run-actions">
          <button v-if="run.paused" class="primary" type="button" :disabled="busy" @click="reviewUpdateControl('resume')">继续处理</button>
          <button v-else type="button" :disabled="busy" @click="reviewUpdateControl('pause')">暂停处理</button>
          <button class="cancel" type="button" :disabled="busy" @click="reviewUpdateControl('cancel')">取消本次运行</button>
          <button v-if="leasesRequired" type="button" :disabled="busy" @click="emit('release')">释放控制权</button>
        </div>
        <button v-else-if="active && canEdit" type="button" :disabled="busy" @click="emit('claim')">{{ occupied ? '尝试领取运行控制权' : '领取运行控制权' }}</button>
        <p v-if="active && occupied && !hasControl" class="run-note">另一客户端持有运行控制权，本窗口只读。</p>
      </div>
      <details v-for="operation in run.operations" :key="`${run.id}:${operation.id}`" class="operation-group" :open="operation.status !== 'completed'">
        <summary><strong>{{ graphReadOperationLabel(operation) }}</strong><span>{{ graphReadOperationProgress(operation) }}</span></summary>
        <ul v-if="!run.paused && activities?.some(/* 会话提供的活动摘要，用 Operation 身份匹配本行。 */ item => /* 只显示当前 Operation 的执行活动。 */ item.operationId === operation.id)" class="activity-list" aria-label="当前执行活动">
          <li v-for="item in activities.filter(/* 会话提供的活动摘要，用 Operation 身份匹配本行。 */ item => /* 只显示当前 Operation 的执行活动。 */ item.operationId === operation.id)" :key="item.workId">
            <strong>{{ item.agentName }}</strong> · {{ ACTIVITY_LABELS[item.status] }}
          </li>
        </ul>
        <OperationReview :snapshot="snapshot" :run="run" :operation="operation" :can-edit="canEdit" :can-control="hasControl" :busy="busy" @answer="emit('answer', $event)" />
      </details>
    </template>
  </section>
</template>

<style scoped>
/* 分隔各操作进度和活动列表，并区分取消与运行说明。 */
.activity-list{padding:0 18px 10px 30px;font-size:12px;line-height:1.8;color:var(--text-muted)}
.operation-group{border-top:1px solid var(--border-subtle)}.operation-group>summary{padding:10px 14px;cursor:pointer;line-height:1.6}.operation-group>summary strong{font-size:12px}.operation-group>summary span{display:block;margin-left:15px;font-size:11px;color:var(--text-muted)}
.run-panel{border-top:1px solid var(--border);background:var(--bg-panel)}header{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px}h2{font-size:14px}header span,.run-summary p{font-size:11px;color:var(--text-muted)}.run-summary{display:grid;gap:9px;padding:0 14px 14px;line-height:1.6}.run-summary>strong{font-size:12px}.run-note{padding:12px 14px;color:var(--text-muted);line-height:1.7}.run-summary .run-note{padding:0}.run-actions{display:flex;gap:8px;flex-wrap:wrap}.cancel,.run-summary .error{color:var(--danger)}
</style>
