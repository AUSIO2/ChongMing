<!-- 显式组只使用各scope输入端口的真实节点，不编造未来输出成员。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { DefinitionCatalog, TransitionInputPort } from '../../../../contracts/data-definition'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphPlanGrouping, GraphRunStep } from '../../../../contracts/graph-run'
import { graphReadNodeText } from '../graph/graph-layout'

const props = defineProps<{ grouping: GraphPlanGrouping; input: GraphRunStep['input']; ports: readonly TransitionInputPort[]; snapshot: GraphSnapshot | null; catalog: DefinitionCatalog | null; disabled: boolean }>()
const emit = defineEmits<{ change: [grouping: GraphPlanGrouping] }>()
const canEach = computed(() => /* 逐个必须单input且单节点能满足每组数量。 */ props.ports.length === 1 && props.ports[0].count.min <= 1 && props.ports[0].count.max >= 1)
const canExplicit = computed(() => /* 启动前尚不知道前步产物ID，不能做静态成员表。 */ props.input.length === props.ports.length && props.input.every((/* 一个完整输入绑定。 */ binding) => /* context不参与组成员。 */ binding.source.kind === 'scope'))
const groups = computed(() => /* 原组身份保留，不用显示序号重写实际ID。 */ props.grouping.mode === 'explicit' ? props.grouping.groups : [])

function changeMode(/* 真实分组选择框事件。 */ event: Event): void {
  // 切换规则是用户明确动作，显式模式从空表开始逐组填写。
  const target = event.target
  if (props.disabled || !(target instanceof HTMLSelectElement)) return
  if (target.value === 'all') emit('change', { mode: 'all' })
  else if (target.value === 'each' && canEach.value) emit('change', { mode: 'each' })
  else if (target.value === 'explicit' && canExplicit.value) emit('change', { mode: 'explicit', groups: [] })
}
function addGroup(): void {
  // 组数不冒用步骤64上限，成员实际数量由端口定义核对。
  if (props.disabled || !canExplicit.value || props.grouping.mode !== 'explicit') return
  emit('change', { mode: 'explicit', groups: [...groups.value, { id: crypto.randomUUID(), members: Object.fromEntries(props.ports.map(
    (/* 当前声明的输入端口。 */ port) => /* 用自有属性建立空成员，支持constructor等合法名称。 */ [port.name, []],
  )) }] })
}
function removeGroup(/* 用户明确移除的稳定分组身份。 */ id: string): void {
  // 不重编号其它组或改变其成员。
  if (!props.disabled) emit('change', { mode: 'explicit', groups: groups.value.filter((/* 一份原组。 */ group) => /* 只移除指定组。 */ group.id !== id) })
}
function choices(/* 需要读取实际来源成员的端口。 */ port: string) {
  // 只给出该端口已选且仍存在的节点，无法选择其它输入或未来产物。
  const source = props.input.find((/* 该步骤的一项输入。 */ binding) => /* 精确端口名称。 */ binding.port === port)?.source
  if (source?.kind !== 'scope') return []
  return props.snapshot?.nodes.filter((/* 当前保存节点。 */ node) => /* 组间可以复用，不跨端口扩成员。 */ source.nodeIds.includes(node.id)) ?? []
}
function members(/* 一组的原成员字典。 */ group: { members: Record<string, string[]> }, /* 精确输入端口名称。 */ port: string): string[] {
  // 缺省可选端口为空，不把对象继承属性当成员列表。
  return Object.prototype.hasOwnProperty.call(group.members, port) ? group.members[port] : []
}
function toggleMember(/* 当前组身份。 */ groupId: string, /* 当前输入端口。 */ port: string, /* 实际可用的节点身份。 */ id: string): void {
  // 每次复制字典和数组，绑定不会改图，也不强制不同组互斥。
  if (props.disabled || !canExplicit.value || !choices(port).some((/* 本端口可选成员。 */ node) => /* 不从任意字符串加入节点。 */ node.id === id)) return
  emit('change', { mode: 'explicit', groups: groups.value.map((/* 一份原组。 */ group) => {
    // 仅替换用户操作的这个组和这个端口。
    if (group.id !== groupId) return group
    const ids = members(group, port)
    return { id: group.id, members: { ...group.members, [port]: ids.includes(id)
      ? ids.filter((/* 原端口成员。 */ current) => /* 删除该精确身份。 */ current !== id) : [...ids, id] } }
  }) })
}
</script>

<template>
  <section class="grouping">
    <label>分组方式<select :value="grouping.mode" :disabled="disabled" @change="changeMode"><option value="each" :disabled="!canEach">逐个</option><option value="all">全部一起</option><option value="explicit" :disabled="!canExplicit">显式分组</option></select></label>
    <p v-if="!canEach">逐个处理需要一个输入端口，且单节点满足该端口数量。</p>
    <p v-if="!canExplicit">显式分组需要全部输入来自本图保存节点；前步产物可选逐个或全部一起。</p>
    <template v-if="grouping.mode === 'explicit'">
      <button type="button" :disabled="disabled || !canExplicit" @click="addGroup">添加分组</button>
      <section v-for="(group, index) in groups" :key="group.id" :aria-label="`分组 ${index + 1}`" class="group">
        <header><h4>分组 {{ index + 1 }}</h4><button type="button" :disabled="disabled" @click="removeGroup(group.id)">移除分组 {{ index + 1 }}</button></header>
        <fieldset v-for="port in ports" :key="port.name" :disabled="disabled || !canExplicit"><legend>分组端口 {{ port.name }}</legend><p>每组 {{ port.count.min }}–{{ port.count.max }} 项 · 已选 {{ members(group, port.name).length }}</p><label v-for="node in choices(port.name)" :key="node.id" class="member"><input type="checkbox" :value="node.id" :checked="members(group, port.name).includes(node.id)" :aria-label="`${graphReadNodeText(node, catalog)} · ${node.id}`" @change="toggleMember(group.id, port.name, node.id)"><span>{{ graphReadNodeText(node, catalog) }} · {{ node.id.slice(0, 8) }}</span></label></fieldset>
      </section>
    </template>
  </section>
</template>

<style scoped>
.grouping,.group{display:grid;gap:10px;min-width:0}label{display:grid;gap:5px;font-size:12px}.grouping>button{justify-self:start}p{font-size:11px;line-height:1.7;color:var(--text-muted)}.group{border-left:2px solid var(--border);padding-left:12px}header{display:flex;gap:10px;justify-content:space-between;align-items:center}h4{font-size:12px}header button{font-size:11px}fieldset{display:grid;gap:6px;min-width:0;padding:9px;border:1px solid var(--border-subtle)}legend{font-size:12px}.member{display:flex;gap:7px;align-items:start;line-height:1.7}.member input{flex:none;margin-top:5px}.member span{overflow-wrap:anywhere}
</style>
