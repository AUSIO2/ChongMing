import { describe, expect, it } from 'vitest'
import {
  MAP_DEFAULT_NEWS_ID,
  mapIdCreateClaim,
  mapIdCreateInstance,
  mapIdCreateRoute,
  mapIdReadAgentName,
  mapIdUpdateInstance,
} from '@flow-map/ids'

describe('map ids', () => {
  it('allocates stable route instances', () => {
    expect(mapIdCreateInstance('a', [{ instanceId: 'a#2' }])).toBe('a#3')
    expect(mapIdReadAgentName('source credibility#2')).toBe('source credibility')
    expect(mapIdUpdateInstance([
      { agentName: 'a', priority: 'high' },
      { agentName: 'a', priority: 'low' },
    ]).map(route => route.instanceId)).toEqual(['a#1', 'a#2'])
  })

  it('scopes route and claim ids by parent', () => {
    expect(mapIdCreateRoute({ instanceId: 'a#1' }, MAP_DEFAULT_NEWS_ID)).toBe('sub:a#1')
    expect(mapIdCreateRoute({ instanceId: 'a#1' }, 'claim:1')).toBe('sub:claim:1:a#1')
    expect(mapIdCreateClaim(0, MAP_DEFAULT_NEWS_ID)).toBe('1')
    expect(mapIdCreateClaim(0, 'news:a')).toBe('claim:news:a:1')
  })
})
