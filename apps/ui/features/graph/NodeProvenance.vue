<!-- 复用已保存创建来源，向页面发送带原图身份的只读历史导航意图。 -->
<script setup lang="ts">
import { computed } from 'vue'

import type { GraphNode } from '../../../../contracts/graph'
import { provenanceReadNode, type OperationOriginOpen } from './node-origin'

const props = defineProps<{
  node: GraphNode
  workspaceId: string
  mapId: string
  historyAvailable: boolean
}>()
const emit = defineEmits<{ openOperation: [input: OperationOriginOpen] }>()
const provenance = computed(() => /* 只读保存元数据，不借用正文草稿或当前智能体目录。 */ provenanceReadNode(props.node))

function provenanceOpenHistory(): void {
  // 固定当前来源节点与实际图身份；历史读取由页面已有面板负责。
  const target = provenance.value.target
  if (!target || !props.historyAvailable) return
  emit('openOperation', { workspaceId: props.workspaceId, mapId: props.mapId, target })
}
</script>

<template>
  <section class="node-provenance" aria-label="创建来源">
    <header><h3>创建来源</h3><strong>{{ provenance.label }}</strong></header>
    <dl>
      <div v-for="row in provenance.rows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
    </dl>
    <template v-if="provenance.target">
      <button type="button" :disabled="!historyAvailable" @click="provenanceOpenHistory">查看生成记录</button>
      <p v-if="!historyAvailable">当前服务未提供运行历史目录，暂不能定位生成记录。</p>
    </template>
    <details v-if="provenance.packageRows?.length">
      <summary>包内保留记录</summary>
      <p>以下为导入包中保留的元数据，智能体标识可能已重映射，不能用于定位本地图运行。</p>
      <dl><div v-for="row in provenance.packageRows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div></dl>
    </details>
  </section>
</template>

<style scoped>
.node-provenance{display:grid;gap:10px;min-width:0;padding:12px 0;border-top:1px solid var(--border-subtle);font-size:12px;line-height:1.7}
header{display:flex;align-items:baseline;justify-content:space-between;gap:10px}h3{font-size:12px}header strong{font-size:11px;font-weight:500;color:var(--text-muted)}
dl{display:grid;gap:5px;min-width:0}dl>div{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px}dt,p{color:var(--text-muted)}dd{margin:0;overflow-wrap:anywhere}
button{justify-self:start;font-size:12px}details{min-width:0}summary{cursor:pointer}details p{margin:8px 0;font-size:11px}
</style>
