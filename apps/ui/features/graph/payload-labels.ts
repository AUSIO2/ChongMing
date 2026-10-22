// 展示标签只用于前端文案；payload 属性名与 JSON Pointer 始终保留原协议值。
import type { JsonValue } from '../../../../contracts/data-definition'

const fieldLabels = new Map<string, string>([
  ['content', '正文'], ['context', '上下文'], ['value', '内容'], ['visibleToAI', '允许 AI 使用'],
  ['category', '类别'], ['title', '标题'], ['summary', '摘要'], ['description', '说明'],
  ['name', '名称'], ['label', '标签'], ['text', '文本'], ['url', '链接'], ['author', '作者'],
  ['publishedAt', '发布时间'], ['source', '来源'], ['status', '状态'], ['confidence', '置信度'],
  ['locator', '来源位置'], ['kind', '类型'], ['assetId', '文件标识'], ['mediaType', '媒体类型'],
  ['capturedAt', '采集时间'], ['score', '评分'], ['reason', '核查理由'], ['evidenceIds', '证据节点'],
  ['opinionIds', '核查意见节点'], ['legacy', '历史记录'], ['reportId', '报告标识'], ['slotId', '任务槽标识'],
  ['routeRevision', '核查路由版本'], ['agentId', '智能体标识'], ['agentName', '智能体名称'],
  ['angle', '核查角度'], ['tools', '使用工具'], ['createdAt', '创建时间'],
])

const valueLabels: Record<string, Record<string, string>> = {
  kind: { asset: '文件资源', url: '网页链接' },
  category: { data: '数据事实', quote: '引用观点', causal: '因果关系', null: '未分类' },
}

/**
 * 优先精确展示声明，再按最具体的通配路径、schema 标题及常见字段译名显示。
 * 通配符只匹配一个完整的 JSON Pointer 段；未知字段保留解码后的原名。
 */
function payloadReadDeclaredLabel(path: string, labels?: Record<string, string>): string | undefined {
  if (labels && Object.prototype.hasOwnProperty.call(labels, path) && labels[path].trim()) return labels[path]
  const segments = path.split('/')
  let wildcardLabel: string | undefined
  let specificity = -1
  for (const [pattern, label] of Object.entries(labels ?? {})) {
    const patternSegments = pattern.split('/')
    if (!label.trim() || !patternSegments.includes('*') || patternSegments.length !== segments.length) continue
    if (!patternSegments.every((segment, index) => segment === '*' || segment === segments[index])) continue
    const score = patternSegments.filter(segment => segment !== '*').length
    if (score <= specificity) continue
    wildcardLabel = label
    specificity = score
  }
  return wildcardLabel
}

function payloadReadFieldKey(/* 当前字段的 JSON Pointer 或根路径。 */ path: string): string {
  // 直接取得最后一段字符串，根路径也有自然的空字段名。
  return path.slice(path.lastIndexOf('/') + 1).replace(/~1/g, '/').replace(/~0/g, '~')
}

export function payloadReadFieldLabel(path: string, labels?: Record<string, string>, schemaTitle?: string): string {
  const declared = payloadReadDeclaredLabel(path, labels)
  if (declared !== undefined) return declared
  if (schemaTitle?.trim()) return schemaTitle
  const key = payloadReadFieldKey(path)
  return fieldLabels.get(key) ?? (key || '内容')
}

/** 枚举、常量和判别联合只翻译展示文字；控件选项身份由表单维护，提交仍保留原JSON值。 */
export function payloadReadValueLabel(path: string, value: JsonValue, labels?: Record<string, Record<string, string>>): string {
  const key = String(value)
  const declarations: Record<string, string> = {}
  for (const [pattern, options] of Object.entries(labels ?? {})) {
    if (Object.prototype.hasOwnProperty.call(options, key)) declarations[pattern] = options[key]
  }
  const declared = payloadReadDeclaredLabel(path, declarations)
  if (declared !== undefined) return declared
  const field = payloadReadFieldKey(path)
  const options = Object.prototype.hasOwnProperty.call(valueLabels, field) ? valueLabels[field] : undefined
  if (options && Object.prototype.hasOwnProperty.call(options, key)) return options[key]
  if (value === null) return '空值'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value) || '空字符串'
}
