import { describe, expect, it } from 'vitest'
import type { DataSchema, JsonValue } from '../../contracts/data-definition'
import { messageFormat, RuntimeMessage } from '../../contracts/messages'
import { payloadCreateInitial, payloadFormatValue, payloadReadPointer, payloadResolveSchema } from '../../apps/ui/features/graph/data-payload'

describe('Registered data payload helpers', () => {
  it('creates independent minimal values for supported schemas', () => {
    // 表单按required声明顺序建立字段，多个表单不共享定义默认值。
    const schema: DataSchema = { type: 'object', properties: {
      content: { type: 'string', default: 'draft' }, visible: { type: 'boolean' }, optional: { type: ['string', 'null'] },
      items: { type: 'array', items: { type: 'string' } },
    }, required: ['items', 'visible', 'content'], additionalProperties: false }
    const first = payloadCreateInitial(schema), second = payloadCreateInitial(schema)
    expect(first).toEqual({ content: 'draft', visible: false, items: [] })
    expect(first).not.toBe(second)
    expect(JSON.stringify(first)).toBe('{"items":[],"visible":false,"content":"draft"}')
    expect(payloadCreateInitial({ type: 'object' })).toEqual({})
    expect(payloadCreateInitial({ type: 'object', required: [] })).toEqual({})
  })

  it('reads escaped JSON pointer paths and formats display values', () => {
    const payload = { 'a/b': { '~name': ['one', 'two'] } }
    expect(payloadReadPointer(payload, '/a~1b/~0name/1')).toBe('two')
    expect(payloadFormatValue(payloadReadPointer(payload, '/a~1b/~0name'))).toBe('["one","two"]')
    expect(payloadReadPointer(payload, '/missing')).toBeUndefined()
  })

  it('reads only own JSON members while preserving explicit prototype-named fields', () => {
    // 合法JSON同名字段可读，缺少的字段不能从Object原型取得函数或容器。
    const payload = JSON.parse('{"__proto__":{"constructor":"固定正文"},"toString":0}')
    expect(payloadReadPointer({}, '/constructor')).toBeUndefined()
    expect(payloadReadPointer({}, '/toString')).toBeUndefined()
    expect(payloadReadPointer({}, '/__proto__')).toBeUndefined()
    expect(payloadReadPointer(payload, '/__proto__/constructor')).toBe('固定正文')
    expect(payloadReadPointer(payload, '/toString')).toBe(0)
  })

  it.each<JsonValue>([0, { note: '原型同名字段的对象正文' }])('keeps required prototype-named properties as own payload fields', (
    /* 真实JSON默认值，分别覆盖原型setter会忽略和接纳的值类型。 */ value,
  ) => {
    // 已发布定义允许同名属性；初值必须保留正文而不改变对象原型。
    const properties: Record<string, DataSchema> = Object.fromEntries([
      ['__proto__', { default: value }], ['constructor', { type: 'string', default: '字段构造说明' }],
      ['toString', { type: 'boolean', default: false }],
    ])
    const initial = payloadCreateInitial({ type: 'object', properties, required: ['__proto__', 'constructor', 'toString'] })

    expect(JSON.stringify(initial)).toBe(JSON.stringify({ ['__proto__']: value, constructor: '字段构造说明', toString: false }))
    expect(Object.prototype.hasOwnProperty.call(initial, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(initial)).toBe(Object.prototype)
  })

  it('resolves published definition names containing dots when building an object form', () => {
    // 已发布协议允许点号；引用字段必须保留其对象形状和必填子字段。
    const detail: DataSchema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }
    const reference: DataSchema = { $ref: '#/definitions/node.v1' }
    const schema: DataSchema = {
      type: 'object', properties: { detail: reference }, required: ['detail'], definitions: { 'node.v1': detail },
    }

    expect(payloadResolveSchema(reference, schema)).toBe(detail)
    expect(payloadCreateInitial(schema)).toEqual({ detail: { label: '' } })
  })

  it('reports a missing schema target instead of presenting an unresolved reference as text', () => {
    // 缺少目标代表定义不变式已破坏，不能再给表单制造空字符串成功结果。
    const reference: DataSchema = { $ref: '#/definitions/missing' }
    const expected = messageFormat(RuntimeMessage.SCHEMA_UNSUPPORTED_VALUE, reference.$ref)

    expect(() => /* 直接解析必须暴露缺失目标。 */ payloadResolveSchema(reference, {})).toThrow(expected)
    expect(() => /* 创建表单也不得将相同缺失目标当成字符串。 */ payloadCreateInitial(reference)).toThrow(expected)
  })
})
