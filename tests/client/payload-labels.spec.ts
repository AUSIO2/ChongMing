import { describe, expect, it } from 'vitest'
import { EvidenceMessage } from '../../contracts/evidence-library'
import { uiReadErrorMessage } from '../../apps/ui/presentation/ui-labels'
import { payloadReadFieldLabel } from '../../apps/ui/features/graph/payload-labels'
import { readerReadFieldLabel, readerReadFields } from '../../apps/ui/features/reader/reader-content'
import type { DataTypeDefinition } from '../../contracts/data-definition'
import type { GraphNode } from '../../contracts/graph'

const definition: DataTypeDefinition = {
  id: 'news', version: 1, title: '新闻', references: [], successorTypes: [],
  agentProjection: { include: ['/content'], mapEntryFilters: [] },
  schema: {
    type: 'object', properties: { content: { type: 'string' }, context: { type: 'object', additionalProperties: { $ref: '#/definitions/context' } } },
    definitions: { context: { type: 'object', properties: { value: { type: 'string', title: '背景内容' }, visibleToAI: { type: 'boolean' } } } },
  },
}

describe('payload display labels', () => {
  it('explains a changed publication preview in Chinese', () => {
    // 发布审核版本冲突应提示重新核对，而不是只显示未知错误。
    expect(uiReadErrorMessage('Publication preview changed; review the current publication preview before approving'))
      .toBe('发布预览已变化，请重新核对后再批准。')
  })

  it('shows evidence reference errors in Chinese and keeps unknown errors as text', () => {
    // 引用错误有明确中文，未登记系统文本与对象原型名称都保持通用字符串提示。
    expect(uiReadErrorMessage(EvidenceMessage.DIGEST_MISMATCH)).toBe('引用的内容摘要与固定证据不一致，请重新核对。')
    expect(uiReadErrorMessage(EvidenceMessage.USE_REASON_REQUIRED)).toBe('请填写本次使用这条证据的理由。')
    expect(uiReadErrorMessage('原引用已保留')).toBe('原引用已保留')
    for (const message of ['toString', '__proto__', 'Unexpected service failure']) {
      expect(uiReadErrorMessage(message)).toBe('操作未完成，请按错误编号查看详情或重试。')
    }
  })

  it('translates the news form and reader without changing paths or payload keys', () => {
    const node: GraphNode = { id: 'node', typeId: 'news', typeVersion: 1, revision: 0,
      payload: { content: '原文', context: { field: { value: '背景', visibleToAI: false } } },
      createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' }
    const original = JSON.stringify(node.payload)
    expect(readerReadFields(node, definition).map(field => [field.path, field.label])).toEqual([
      ['/content', '正文'], ['/context', '上下文'],
    ])
    expect(readerReadFieldLabel('/context/field/value', definition)).toBe('背景内容')
    expect(readerReadFieldLabel('/context/field/visibleToAI', definition)).toBe('允许 AI 使用')
    expect(JSON.stringify(node.payload)).toBe(original)
  })

  it('honors exact presentation labels and the most specific matching wildcard before schema titles', () => {
    const labels = { '/*/*/value': '通用内容', '/context/*/value': '上下文内容', '/context/topic/value': '主题内容' }
    expect(payloadReadFieldLabel('/context/topic/value', labels, '声明标题')).toBe('主题内容')
    expect(payloadReadFieldLabel('/context/author/value', labels, '声明标题')).toBe('上下文内容')
    expect(payloadReadFieldLabel('/content', labels, '声明标题')).toBe('声明标题')
    expect(payloadReadFieldLabel('/context/author/details/value', labels)).toBe('内容')
  })

  it('preserves unknown and escaped property names as text, including inherited object names', () => {
    expect(payloadReadFieldLabel('/context/customKey')).toBe('customKey')
    expect(payloadReadFieldLabel('/a~1b~0c')).toBe('a/b~c')
    expect(payloadReadFieldLabel('/constructor')).toBe('constructor')
    expect(payloadReadFieldLabel('/context', { '/context': '' })).toBe('上下文')
  })
})
