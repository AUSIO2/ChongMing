<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  GraphInterruptNode,
  GraphStatePatch,
  GraphType,
  Priority,
  RouteInstruction,
  SplitGraphStateDTO,
  VerifyGraphStateDTO,
} from '../../electron/api/types'

const props = defineProps<{
  graphType: GraphType
  nextNode: GraphInterruptNode
  state: SplitGraphStateDTO | VerifyGraphStateDTO
}>()

const emit = defineEmits<{
  resume: [patch: GraphStatePatch]
}>()

const priorities: Priority[] = ['high', 'medium', 'low']
const scores = [1, 0.5, 0] as const

const routeInstructions = ref<RouteInstruction[]>([])
const mergedClaims = ref<Array<{ content: string; category?: string; sourceAgent?: string }>>([])
const finalScore = ref<1 | 0.5 | 0>(0.5)
const finalReason = ref('')

function isSplitState(s: typeof props.state): s is SplitGraphStateDTO {
  return 'mergedClaims' in s
}

const splitState = computed(() => (isSplitState(props.state) ? props.state : null))
const verifyState = computed(() => (!isSplitState(props.state) ? props.state : null))

watch(
  () => props.state,
  (state) => {
    routeInstructions.value = state.routeInstructions.map(r => ({ ...r }))
    if (isSplitState(state)) {
      mergedClaims.value = state.mergedClaims.map(c => ({ ...c }))
    } else {
      finalScore.value = state.finalScore
      finalReason.value = state.finalReason
    }
  },
  { immediate: true },
)

function addRoute() {
  routeInstructions.value.push({ agentName: '', priority: 'medium', hint: '' })
}

function removeRoute(index: number) {
  routeInstructions.value.splice(index, 1)
}

function addClaim() {
  mergedClaims.value.push({ content: '', category: '', sourceAgent: 'manual' })
}

function removeClaim(index: number) {
  mergedClaims.value.splice(index, 1)
}

function buildPatch(): GraphStatePatch {
  if (props.nextNode === 'subAgent') {
    const routes = routeInstructions.value
      .map(r => ({ ...r }))
      .filter(r => r.agentName.trim())
    return routes.length ? { routeInstructions: routes } : null
  }

  // merge 节点尚未执行，不提交空 mergedClaims / 默认核查分
  if (props.nextNode === 'merge') {
    return null
  }

  if (props.graphType === 'split' && isSplitState(props.state)) {
    const claims = mergedClaims.value
      .map(c => ({ ...c }))
      .filter(c => c.content.trim())
    return claims.length ? { mergedClaims: claims } : null
  }

  return {
    finalScore: finalScore.value,
    finalReason: finalReason.value,
  }
}

function submit() {
  emit('resume', buildPatch())
}

function skip() {
  emit('resume', null)
}
</script>

<template>
  <div class="hitl panel">
    <h3 class="panel-title">
      人工审核 — {{ nextNode }}
      <span class="graph-tag">{{ graphType }}</span>
    </h3>

    <p v-if="nextNode === 'merge'" class="hint">
      下一步将执行合并节点（LLM 调用），当前无需编辑结果。直接点「继续」即可。
    </p>

    <!-- subAgent: 路由指令 -->
    <template v-if="nextNode === 'subAgent'">
      <div v-for="(route, i) in routeInstructions" :key="i" class="card">
        <div class="card-row">
          <label>Agent</label>
          <input v-model="route.agentName" placeholder="SubAgent 名称" />
        </div>
        <div class="card-row">
          <label>优先级</label>
          <select v-model="route.priority">
            <option v-for="p in priorities" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div class="card-row">
          <label>Hint</label>
          <input v-model="route.hint" placeholder="可选提示" />
        </div>
        <button class="danger-btn" @click="removeRoute(i)">删除</button>
      </div>
      <button @click="addRoute">+ 添加角度</button>
    </template>

    <!-- merge: 展示 SubAgent 中间结果 -->
    <template v-else-if="nextNode === 'merge' && splitState">
      <div
        v-for="result in splitState.subAgentResults"
        :key="result.agentName"
        class="card readonly"
      >
        <strong>{{ result.agentName }}</strong>
        <ul v-if="result.claims.length" class="mini-list">
          <li v-for="(claim, i) in result.claims" :key="i">{{ claim.content }}</li>
        </ul>
        <p v-else class="empty-line">（该角度未拆分出事实）</p>
      </div>
      <p v-if="!splitState.subAgentResults.length" class="empty-line">
        路由为空，将直接进入合并节点。
      </p>
    </template>

    <template v-else-if="nextNode === 'merge' && verifyState">
      <div
        v-for="opinion in verifyState.subAgentOpinions"
        :key="opinion.agentName"
        class="card readonly"
      >
        <strong>{{ opinion.agentName }}</strong>
        <p>score: {{ opinion.score }} — {{ opinion.reason || '（无理由）' }}</p>
      </div>
    </template>

    <!-- save: 拆分最终结果 -->
    <template v-else-if="nextNode === 'save' && graphType === 'split'">
      <div v-for="(claim, i) in mergedClaims" :key="i" class="card">
        <div class="card-row">
          <label>内容</label>
          <textarea v-model="claim.content" rows="2" />
        </div>
        <div class="card-row">
          <label>分类</label>
          <input v-model="claim.category" />
        </div>
        <button class="danger-btn" @click="removeClaim(i)">删除</button>
      </div>
      <button @click="addClaim">+ 添加事实</button>
      <p v-if="!mergedClaims.length" class="empty-line warn">
        合并结果为空。可手动添加事实，或点「继续」保存空列表。
      </p>
    </template>

    <!-- save: 核查最终结果 -->
    <template v-else>
      <div class="card">
        <div class="card-row">
          <label>置信度</label>
          <select v-model.number="finalScore">
            <option v-for="s in scores" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div class="card-row">
          <label>理由</label>
          <textarea v-model="finalReason" rows="3" />
        </div>
      </div>
    </template>

    <div class="actions">
      <button class="primary" @click="submit">
        {{ nextNode === 'merge' ? '继续' : '提交修改并继续' }}
      </button>
      <button @click="skip">不修改，继续</button>
    </div>
  </div>
</template>

<style scoped>
.hitl {
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.graph-tag {
  font-weight: 400;
  text-transform: none;
  color: var(--primary);
}

.hint {
  font-size: 0.8125rem;
  color: var(--text-muted);
  line-height: 1.5;
}

.card {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.625rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.card.readonly {
  background: #f9fafb;
}

.card-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.card-row label {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.mini-list {
  margin: 0.25rem 0 0 1rem;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.empty-line {
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.empty-line.warn {
  color: var(--warning);
}

.danger-btn {
  align-self: flex-start;
  color: var(--danger);
  border-color: var(--danger);
  font-size: 0.75rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}
</style>
