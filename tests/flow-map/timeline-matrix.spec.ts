import { describe, expect, it } from 'vitest'
import { timelineCreateDefault, timelineResolveKeys } from '@flow-map/timeline'
import { TEST_TIMELINE_WINDOWS } from './fixtures/timeline-matrix'

describe('timeline-matrix windows', () => {
  it.each(TEST_TIMELINE_WINDOWS)('resolveKeys start=$startX end=$endX', ({ startX, endX, keys }) => {
    const effectiveX = startX
    expect(timelineResolveKeys(
      { ...timelineCreateDefault(), startX, endX },
      effectiveX,
    )).toEqual(keys)
  })
})
