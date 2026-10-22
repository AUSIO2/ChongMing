<!-- 只编辑通用职责和精确阶段声明，保存与读取继续由原智能体管理页负责。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { AgentBinding, AgentInput } from '../../../../contracts/control'
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import { agentBuildBoundDraft, agentReadBindingChoices } from './agent-editor'

const props = defineProps<{ modelValue: AgentInput; catalog: DefinitionCatalog | null; disabled: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: AgentInput] }>()
const selectedKey = ref('')
const locked = computed(() => /* 无真实目录时仅展示保存绑定，不借另一作用域更换配置。 */ props.disabled || props.catalog === null)
const choices = computed(() => /* 角色只决定同职责选项，不要求旧转换已经引用本Agent。 */
  agentReadBindingChoices(props.catalog, props.modelValue.role ?? 'producer'))
const available = computed(() => /* 已选精确身份不再作为可重复添加的选项。 */ choices.value.filter(
  (/* 本职责下的一项合法绑定。 */ choice) => /* 三个身份字段共同去重，不以阶段名代替精确版本。 */
    !props.modelValue.bindings?.some((/* 当前草稿保留的一项绑定。 */ binding) =>
      /* 使用完整转换版本和阶段身份比较。 */ bindingKey(binding) === bindingKey(choice.binding)),
))

function bindingKey(
  /* 一项已发布转换的精确阶段引用。 */ binding: AgentBinding,
): string {
  // 定义身份不包含这些分隔符，组合键同时用于选项和明确移除动作。
  return `${binding.transition.id}@${binding.transition.version}:${binding.stageId}`
}

function bindingChangeRole(
  /* 用户在职责选择框触发的真实事件。 */ event: Event,
): void {
  // 更换职责保留原绑定和变量，冲突由管理页提示，交用户明确处理。
  const target = event.target
  if (locked.value || !(target instanceof HTMLSelectElement)) return
  const role = target.value
  if (role !== 'producer' && role !== 'planner' && role !== 'selector') return
  emit('update:modelValue', agentBuildBoundDraft(props.modelValue, role, props.modelValue.bindings ?? []))
}

function bindingAdd(): void {
  // 只接受当前真实目录中的显式选择，不拼造阶段或自动追加默认绑定。
  if (locked.value) return
  const choice = available.value.find((/* 当前可加入的一项精确绑定。 */ item) => /* 固定用户所选的完整组合键。 */ bindingKey(item.binding) === selectedKey.value)
  if (!choice) return
  emit('update:modelValue', agentBuildBoundDraft(props.modelValue, props.modelValue.role ?? 'producer', [
    ...(props.modelValue.bindings ?? []), choice.binding,
  ]))
  selectedKey.value = ''
}

function bindingRemove(
  /* 用户明确移除的原保存绑定，未解析项也保留原身份。 */ removed: AgentBinding,
): void {
  // 删除仅作用于这一项草稿声明，不修改已发布转换、其它绑定或提示词变量。
  if (locked.value) return
  const bindings = (props.modelValue.bindings ?? []).filter((/* 草稿中的一项精确绑定。 */ binding) =>
    /* 不按同名阶段删除其它版本的声明。 */ bindingKey(binding) !== bindingKey(removed))
  emit('update:modelValue', agentBuildBoundDraft(props.modelValue, props.modelValue.role ?? 'producer', bindings))
}

watch(available, (/* 最新目录和职责下尚未加入的选项。 */ current) => {
  // 已失效的候选选择不带到另一职责或目录，但不触碰用户已选绑定。
  if (!current.some((/* 当前一项可加入绑定。 */ choice) => /* 仅保留仍真实可选的候选。 */ bindingKey(choice.binding) === selectedKey.value)) selectedKey.value = ''
})
</script>

<template>
  <section class="bindings-editor" aria-label="智能体阶段绑定">
    <label>阶段职责<select :value="modelValue.role" :disabled="locked" @change="bindingChangeRole"><option value="producer">生成内容</option><option value="planner">规划任务</option><option value="selector">选择结果</option></select></label>
    <p>绑定声明可参与的精确阶段；实际运行仍使用转换或规划保存的智能体版本。</p>
    <p v-if="!catalog">当前服务未提供本范围的定义目录，保存绑定保留，新增或更换绑定暂不可用。</p>
    <div class="binding-add"><label>可绑定阶段<select v-model="selectedKey" :disabled="locked || !available.length"><option value="">选择一个已发布阶段</option><option v-for="choice in available" :key="bindingKey(choice.binding)" :value="bindingKey(choice.binding)">{{ choice.title }}</option></select></label><button type="button" :disabled="locked || !selectedKey" @click="bindingAdd">添加绑定</button></div>
    <p v-if="catalog && !available.length">没有其它同职责的已发布阶段可添加。</p>
    <ul class="binding-list" aria-label="已选阶段绑定">
      <li v-for="binding in modelValue.bindings ?? []" :key="bindingKey(binding)"><span>{{ binding.transition.id }}@{{ binding.transition.version }} · {{ binding.stageId }}</span><button type="button" :aria-label="`移除绑定 ${bindingKey(binding)}`" :disabled="locked" @click="bindingRemove(binding)">移除绑定</button></li>
    </ul>
    <p v-if="!modelValue.bindings?.length">至少选择一个阶段后才能保存通用配置。</p>
  </section>
</template>

<style scoped>
.bindings-editor{display:grid;gap:9px;min-width:0;border-top:1px solid var(--border-subtle);padding-top:12px}.bindings-editor label{display:grid;gap:5px;font-size:12px}.bindings-editor p{font-size:12px;line-height:1.7;color:var(--text-muted)}
.binding-add{display:flex;align-items:end;gap:8px;min-width:0}.binding-add label{flex:1;min-width:0}.binding-add select{width:100%;min-width:0}.binding-add button{flex:none}.binding-list{list-style:none;margin:0;padding:0;display:grid;gap:7px}.binding-list li{display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid var(--border-subtle);padding-bottom:7px;font-size:12px}.binding-list span{overflow-wrap:anywhere}.binding-list button{flex:none;font-size:11px}
@media(max-width:600px){.binding-add{display:grid}.binding-add button{justify-self:start}}
</style>
