// 选材表单复用有界库浏览，只保存用户明确选择的精确条目引用。
import { computed, onScopeDispose, shallowRef, watch, type Ref } from 'vue'

import type { ClientGateway } from '../../../../contracts/client'
import type { EvidenceEntrySummary, EvidenceLibraryRef } from '../../../../contracts/evidence-library'
import type { GraphRunStep } from '../../../../contracts/graph-run'
import { evidenceCreateState, type EvidenceUiContext } from './evidence-state'

export interface EvidenceSelectionContext extends EvidenceUiContext { targetKey: string }

export function evidenceCreateSelection(
  /* 已有公共网关，选材只调用有限查询。 */ gateway: ClientGateway,
  /* 表单当前身份、工作区和核查目标。 */ context: Readonly<Ref<EvidenceSelectionContext>>,
  /* 有效候选读取遇到401时由会话退出。 */ onUnauthorized?: () => void | Promise<void>,
) {
  // 浏览和选材各自有明确所有者；库正文和图编辑范围不进入选择数组。
  const browserContext = computed<EvidenceUiContext>(() => /* 只读候选仍沿已有库请求生命周期。 */ ({
    userId: context.value.userId, connectionKey: context.value.connectionKey, workspaceId: context.value.workspaceId,
    active: context.value.active, canEdit: false,
  }))
  const browser = evidenceCreateState(gateway, browserContext, onUnauthorized)
  const selected = shallowRef<EvidenceEntrySummary[]>([])
  const refs = computed<EvidenceLibraryRef[]>(() => /* 每次交付独立且顺序稳定的精确引用。 */
    [...selected.value].sort((/* 首个条目。 */ left, /* 第二条目。 */ right) => /* UI次序不改变材料集合。 */ left.id.localeCompare(right.id))
      .map((/* 用户已经确认的条目。 */ item) => /* 不复制库来源nodeId到目标图。 */ ({ entryId: item.id, contentDigest: item.contentDigest })))
  let closed = false
  function toggle(
    /* 当前已加载摘要或选中行的取消意图。 */ item: EvidenceEntrySummary,
  ): boolean {
    // 只接受实际活动候选；撤销已选项不要求它仍在当前页。
    if (closed || !context.value.active) return false
    if (selected.value.some((/* 原显式选择。 */ current) => /* 同一entry只能选择一次。 */ current.id === item.id)) {
      selected.value = selected.value.filter((/* 原显式选择。 */ current) => /* 只移除用户点选的身份。 */ current.id !== item.id)
      return true
    }
    const candidate = browser.items.value.find((/* 当前库页中的实际条目。 */ current) => /* 绑定原摘要、固定摘要与状态。 */
      current.id === item.id && current.contentDigest === item.contentDigest && current.status === 'active')
    if (!candidate || item.status !== 'active' || selected.value.length >= 32) return false
    selected.value = [...selected.value, { ...candidate }]
    return true
  }
  function clear(): void {
    // 新运行草稿明确清空选择，已有候选查询仍由browser拥有。
    selected.value = []
  }
  const stopIdentity = watch(() => /* 只比较身份与目标标量，切卡重建同身份上下文不清已有材料。 */
    JSON.stringify([context.value.userId, context.value.connectionKey, context.value.workspaceId, context.value.targetKey]),
  () => { /* 不把一个目标的确定证据默认选给另一个目标。 */ clear() }, { flush: 'sync' })
  function dispose(): void {
    // 表单窗口结束时取消读取并移除目标监听，迟到结果不能填充选择。
    if (closed) return
    closed = true
    stopIdentity()
    browser.dispose()
    clear()
  }
  onScopeDispose(dispose, true)
  return { browser, selected, refs, toggle, clear, dispose }
}

export type EvidenceSelection = ReturnType<typeof evidenceCreateSelection>

export function evidenceBindClaimsToStep(
  /* 用户明确选定的实际步骤，函数不修改原对象。 */ step: GraphRunStep,
  /* 选材状态已保证无重复且不超过32条的固定引用。 */ refs: readonly EvidenceLibraryRef[],
): GraphRunStep {
  // 只复制已选步骤及其材料，不重新搜索步骤或重复验证状态拥有者建立的选择规则。
  const result = structuredClone(step)
  if (refs.length) result.libraryClaimRefs = refs.map((/* 原固定引用。 */ ref) => /* 后续选材变化不能改写该步骤。 */ ({ ...ref }))
  else delete result.libraryClaimRefs
  return result
}
