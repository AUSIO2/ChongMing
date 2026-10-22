<!-- 真实 Map 的场景包装：投影真实快照并将共用展示身份映射回完整节点身份。 -->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { GraphActivity } from '../../../../contracts/activity'
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import GraphCanvas from './GraphCanvas.vue'
import GraphScene from './GraphScene.vue'
import { graphRead3DLayout } from './graph-3d-layout'
import { graphReadNodeActivity } from './graph-node-activity'
import type { NodeIdentity } from './node-identity'

const props = withDefaults(defineProps<{
  snapshot: GraphSnapshot
  catalog?: DefinitionCatalog | null
  activities?: GraphActivity[]
  selectedId: string | null
  selectedRunId?: string | null
  active?: boolean
}>(), { active: true })
const emit = defineEmits<{ select: [id: string | null]; open: [identity: NodeIdentity] }>()

const scene = ref<InstanceType<typeof GraphScene> | null>(null)
const fallbackCanvas = ref<InstanceType<typeof GraphCanvas> | null>(null)
const layout = computed(() => /* 将真实 Map 投影到共用场景，不创建第二份业务快照。 */
  graphRead3DLayout(props.snapshot, props.catalog))
const sceneKey = computed(() => /* 绑定完整 Map 身份，跨工作区同名 Map 也会重置视角。 */
  JSON.stringify([props.snapshot.workspaceId, props.snapshot.mapId]))
const nodeStatus = computed(() => {
  // 活动单独投影为文字标记，不写入布局或类型色，不触发相机重置。
  const states = graphReadNodeActivity(props.snapshot, props.selectedRunId ?? null, props.activities ?? [])
  return new Map([...states].map((/* 当前节点身份及只读状态。 */ [id, state]) => /* 陈旧独立保留，不被执行中的标记掩盖。 */ [id, state.stale && state.state !== 'idle' ? `${state.label} · 需要重新处理` : state.label]))
})

function openNode(
  /* 共用场景发出的独立展示身份，在真实 Map 中对应节点 ID。 */
  id: string,
): void {
  // 只为仍在当前快照中的节点发出完整定位身份。
  if (!props.snapshot.nodes.some((/* 当前真实 Map 中待比对的节点。 */ node) =>
    /* 排除快照已切换后的旧展示事件。 */ node.id === id)) return
  emit('open', { workspaceId: props.snapshot.workspaceId, mapId: props.snapshot.mapId, nodeId: id })
}

async function focusSelectedNode(): Promise<void> {
  // 返回 Map 后聚焦实际使用的画布，降级模式仍保留原画布的节点定位行为。
  await nextTick()
  if (fallbackCanvas.value) await fallbackCanvas.value.focusSelectedNode()
  else await scene.value?.focusSelectedNode()
}
defineExpose({ focusSelectedNode })
</script>

<template>
  <GraphScene ref="scene" :layout="layout" :scene-key="sceneKey" :selected-id="selectedId" :active="active" :node-status="nodeStatus"
    label="三维关系图" empty-label="添加第一份数据，开始构建三维关系图。"
    @select="emit('select', $event)" @open="openNode">
    <template #fallback>
      <GraphCanvas ref="fallbackCanvas" :snapshot="snapshot" :catalog="catalog" :node-status="nodeStatus"
        :selected-id="selectedId" :active="active" @select="emit('select', $event)" @open="emit('open', $event)" />
    </template>
  </GraphScene>
</template>
