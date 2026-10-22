<!-- 一个端口只选本图保存节点或一个前序正式输出，不合并隐含来源。 -->
<script setup lang="ts">
import type { DefinitionCatalog, TransitionInputPort } from '../../../../contracts/data-definition'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphRunStep } from '../../../../contracts/graph-run'
import { graphReadNodeText, graphReadNodeType } from '../graph/graph-layout'
import type { RunDraft, RunStepDraft } from './run-draft'

type Source = GraphRunStep['input'][number]['source']
const props = defineProps<{ draft: RunDraft; step: RunStepDraft; kind: 'input' | 'context'; ports: readonly TransitionInputPort[]; snapshot: GraphSnapshot | null; catalog: DefinitionCatalog | null; disabled: boolean }>()
const emit = defineEmits<{ bind: [value: { port: string; source: Source }] }>()

function bindingSource(/* 当前精确端口名称。 */ port: string): Source {
  // 缺失绑定只呈现空选择，仍由完整草稿校验阻止遗漏端口提交。
  return props.step[props.kind].find((/* 该类端口的保存绑定。 */ binding) => /* 不借用另一类同名端口。 */ binding.port === port)?.source ?? { kind: 'scope', nodeIds: [] }
}
function sourceKey(/* 正在显示的端口来源。 */ source: Source): string {
  // step UUID与定义端口不包含冒号，scope独立表示本图选择。
  return source.kind === 'scope' ? 'scope' : `${source.stepId}:${source.port}`
}
function nodeChoices(/* 需要匹配输入类型的端口。 */ port: TransitionInputPort) {
  // 只提供本图精确类型/版本，不把库来源或其它图节点混入范围。
  return props.snapshot?.nodes.filter((/* 当前图已保存的真实节点。 */ node) => /* 节点版本类型必须匹配。 */ node.typeId === port.inputType.id && node.typeVersion === port.inputType.version) ?? []
}
function outputChoices(/* 需要精确类型匹配的输入或上下文端口。 */ port: TransitionInputPort) {
  // 只选前序步骤的一个输出，端口选择会由草稿模块补上可见直接依赖。
  const index = props.draft.steps.findIndex((/* 当前有序列表中的步骤。 */ step) => /* 用稳定身份定位。 */ step.id === props.step.id)
  return props.draft.steps.slice(0, Math.max(0, index)).flatMap((/* 前序步骤。 */ step, /* 人类可见序号位置。 */ position) => {
    // 选项取发布目录，不预测该步未来实际产物总数。
    const transition = props.catalog?.transitions.find((/* 已发布转换。 */ item) => /* 保留精确转换版本。 */ item.id === step.transitionRef?.id && item.version === step.transitionRef.version)
    return transition?.ports.output.filter((/* 已发布输出端口。 */ output) => /* 相同ID的其它版本也不兼容。 */ output.outputType.id === port.inputType.id && output.outputType.version === port.inputType.version)
      .map((/* 可参与此绑定的精确输出。 */ output) => /* 输出选择是端口引用，不是假造节点ID。 */ ({ key: `${step.id}:${output.name}`, source: { kind: 'step' as const, stepId: step.id, port: output.name }, label: `步骤 ${position + 1} · ${transition.title} · ${transition.id}@${transition.version} · ${output.name}` })) ?? []
  })
}
function changeSource(/* 用户操作的端口。 */ port: TransitionInputPort, /* 来源下拉框的真实事件。 */ event: Event): void {
  // 明确切来源才替换端口绑定，不保留另一种隐含输入。
  const target = event.target
  if (props.disabled || !(target instanceof HTMLSelectElement)) return
  if (target.value === 'scope') emit('bind', { port: port.name, source: { kind: 'scope', nodeIds: [] } })
  else {
    const choice = outputChoices(port).find((/* 当前可选正式输出。 */ item) => /* 不从任意字符串拼接来源。 */ item.key === target.value)
    if (choice) emit('bind', { port: port.name, source: choice.source })
  }
}
function setNodes(/* 被明确修改的本图端口。 */ port: string, /* 用户确认的独立成员列表。 */ nodeIds: readonly string[]): void {
  // 全选、清空和逐项勾选都只是本地草稿编辑。
  if (!props.disabled) emit('bind', { port, source: { kind: 'scope', nodeIds: [...nodeIds] } })
}
function toggleNode(/* 当前端口名称。 */ port: string, /* 用户明确切换的真实节点身份。 */ id: string): void {
  // 不触发节点选择或正文保存，重复点击只移除本端口的一个身份。
  const source = bindingSource(port)
  const ids = source.kind === 'scope' ? source.nodeIds : []
  setNodes(port, ids.includes(id) ? ids.filter((/* 原明确成员。 */ current) => /* 只删除所选身份。 */ current !== id) : [...ids, id])
}
function isChecked(/* 当前精确端口。 */ port: string, /* 当前候选节点身份。 */ id: string): boolean {
  // 使用完整节点ID，不把同正文节点当同一成员。
  const source = bindingSource(port)
  return source.kind === 'scope' && source.nodeIds.includes(id)
}
</script>

<template>
  <div class="ports">
    <fieldset v-for="port in ports" :key="port.name" class="port" :disabled="disabled">
      <legend>{{ kind === 'input' ? '输入端口' : '上下文端口' }} {{ port.name }}</legend>
      <p>{{ port.inputType.id }}@{{ port.inputType.version }} · 每组 {{ port.count.min }}–{{ port.count.max }} 项{{ kind === 'context' ? ' · 只读正文，仍进入运行范围授权' : '' }}</p>
      <label>来源 {{ port.name }}<select :value="sourceKey(bindingSource(port.name))" @change="changeSource(port, $event)"><option value="scope">本图已保存节点</option><option v-if="bindingSource(port.name).kind === 'step' && !outputChoices(port).some(choice => choice.key === sourceKey(bindingSource(port.name)))" :value="sourceKey(bindingSource(port.name))">已失效来源 {{ sourceKey(bindingSource(port.name)) }}</option><option v-for="choice in outputChoices(port)" :key="choice.key" :value="choice.key">{{ choice.label }}</option></select></label>
      <template v-if="bindingSource(port.name).kind === 'scope'">
        <div class="actions"><button type="button" @click="setNodes(port.name, nodeChoices(port).map(node => node.id))">{{ kind === 'input' ? '全选符合条件的节点' : '全选上下文节点' }}</button><button type="button" @click="setNodes(port.name, [])">{{ kind === 'input' ? '清空' : '清空上下文' }}</button></div>
        <div class="node-list"><label v-for="node in nodeChoices(port)" :key="node.id" class="node-choice"><input type="checkbox" :value="node.id" :checked="isChecked(port.name, node.id)" :aria-label="`${graphReadNodeText(node, catalog)} · ${node.id}`" @change="toggleNode(port.name, node.id)"><span><small>{{ graphReadNodeType(node, catalog) }} · 内容版本 {{ node.revision }} · {{ node.id.slice(0, 8) }}</small>{{ graphReadNodeText(node, catalog) }}</span></label></div>
        <p v-if="!nodeChoices(port).length">图中没有匹配这个端口精确类型的数据。</p>
      </template>
      <p v-else>实际节点与数量在前步正式发布后确定。</p>
    </fieldset>
  </div>
</template>

<style scoped>
.ports{display:grid;gap:12px;min-width:0}.port{min-width:0;display:grid;gap:9px;padding:10px;border:1px solid var(--border-subtle)}legend{font-size:12px;font-weight:600}label{display:grid;gap:5px;font-size:12px}p,small{font-size:11px;color:var(--text-muted);line-height:1.7}.actions{display:flex;gap:7px;flex-wrap:wrap}.actions button{font-size:11px}.node-list{display:grid;gap:6px;max-height:170px;overflow:auto}.node-choice{display:flex;gap:8px;align-items:start;line-height:1.7}.node-choice input{flex:none;margin-top:5px}.node-choice small{display:block}.node-choice span{overflow-wrap:anywhere}
</style>
