import { describe, expect, it } from 'vitest'
import type { DataSchema } from '../../contracts/data-definition'
import { payloadCreateInitial, payloadFormatValue, payloadReadPointer } from '../../apps/ui/features/graph/data-payload'

describe('Registered data payload helpers', () => {
  it('creates independent minimal values for supported schemas', () => {
    const schema: DataSchema = { type: 'object', properties: {
      content: { type: 'string', default: 'draft' }, visible: { type: 'boolean' }, optional: { type: ['string', 'null'] },
      items: { type: 'array', items: { type: 'string' } },
    }, required: ['content', 'visible', 'items'], additionalProperties: false }
    const first = payloadCreateInitial(schema), second = payloadCreateInitial(schema)
    expect(first).toEqual({ content: 'draft', visible: false, items: [] })
    expect(first).not.toBe(second)
  })

  it('reads escaped JSON pointer paths and formats display values', () => {
    const payload = { 'a/b': { '~name': ['one', 'two'] } }
    expect(payloadReadPointer(payload, '/a~1b/~0name/1')).toBe('two')
    expect(payloadFormatValue(payloadReadPointer(payload, '/a~1b/~0name'))).toBe('["one","two"]')
    expect(payloadReadPointer(payload, '/missing')).toBeUndefined()
  })
})
