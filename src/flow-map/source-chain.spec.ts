import { describe, expect, it } from 'vitest'
import {
  mapIdCreateChain,
  mapIdCreateSource,
  mapIdCreateParse,
  mapIdCreateNews,
  mapIdReadChain,
  mapIdReadInterruptFocus,
} from './ids'
import { docAddSourceChain, docCreate, docReadPendingParseSource } from './graph-doc'

describe('source chain ids', () => {
  it('mapIdCreateChain 生成 source/parse/news 同源', () => {
    const chainId = mapIdCreateChain()
    expect(mapIdReadChain(mapIdCreateSource(chainId))).toBe(chainId)
    expect(mapIdReadChain(mapIdCreateParse(chainId))).toBe(chainId)
    expect(mapIdReadChain(mapIdCreateNews(chainId))).toBe(chainId)
  })

  it('mapIdReadInterruptFocus 0-1 confirmRoute 指向 source', () => {
    const sourceId = mapIdCreateSource('a')
    const { focus, pendingTool } = mapIdReadInterruptFocus('0-1', 'confirmRoute', {
      parentNodeId: sourceId,
    })
    expect(focus).toEqual({ kind: 'source', id: sourceId })
    expect(pendingTool).toBe('invoke')
  })

  it('mapIdReadInterruptFocus 0-1 save 指向 news', () => {
    const newsId = mapIdCreateNews('a')
    const { focus, pendingTool } = mapIdReadInterruptFocus('0-1', 'save', {
      parentNodeId: mapIdCreateSource('a'),
      newsNodeId: newsId,
    })
    expect(focus).toEqual({ kind: 'news', id: newsId })
    expect(pendingTool).toBe('save')
  })
})

describe('docAddSourceChain', () => {
  it('仅追加 source 节点，parse/news 由 fan-out 投影', () => {
    const doc = docCreate('m1')
    const { sourceId } = docAddSourceChain(doc, {
      uri: '/tmp/a.txt',
      label: 'a.txt',
    })
    expect(doc.nodes).toHaveLength(1)
    expect(doc.nodes[0]?.kind).toBe('source')
    expect(docReadPendingParseSource(doc)).toBe(sourceId)
  })
})
