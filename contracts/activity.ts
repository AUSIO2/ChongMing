// 定义可显示的工作活动摘要，并在网络边界限制允许字段、阶段和排序身份。

// 可向界面展示的执行阶段，不包含模型原始文本或工具参数。
export type ActivityStatus = 'preparing' | 'model' | 'tool' | 'result'
export const ACTIVITY_LABELS: Record<ActivityStatus, string> = {
  preparing: '准备处理', model: '正在调用模型', tool: '正在执行工具', result: '正在处理工具结果',
}
// 一次工作执行的活动摘要，以 fence 和 sequence 区分持有者代次及摘要先后。
export interface GraphActivity {
  mapId: string; runId: string; operationId: string; nodeId: string; workId: string
  stageId: string; slotId: string; agentName: string; status: ActivityStatus
  fence: number; sequence: number; updatedAt: string
}

/** 共享网络边界仅接收活动摘要，不将原始运行时负载直接用作展示内容。 */
export function activityIsStatus(/* 网络或未知来源的状态值，仅已登记的展示阶段可通过。 */ value: unknown): value is ActivityStatus {
  // 判断输入是否为已定义的活动展示状态。
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACTIVITY_LABELS, value)
}
export function activityIsRecord(/* 外部活动摘要负载，验证字段、阶段和排序标识后才允许展示。 */ value: unknown): value is GraphActivity {
  // 验证活动摘要的字段、标识和租约代次，拒绝混入原始运行时负载。
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(/* 摘要实际包含的属性名，用于拒绝协议外字段。 */ key => /* 检查摘要中是否夹带协议未允许的字段。 */  !['mapId','runId','operationId','nodeId','workId','stageId','slotId','agentName','status','fence','sequence','updatedAt'].includes(key))) return false
  if (!['mapId','runId','operationId','nodeId','workId','stageId','slotId','agentName','updatedAt'].every(/* 必须为非空有界字符串的摘要字段名。 */ key => /* 要求各标识和展示文本为非空且有长度上限的字符串。 */  typeof item[key] === 'string' && (item[key] as string).length > 0 && (item[key] as string).length <= 256)) return false
  if (!activityIsStatus(item.status) || !Number.isSafeInteger(item.fence) || Number(item.fence) < 1 || !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 1 || !Number.isFinite(Date.parse(String(item.updatedAt)))) return false
  return true
}
