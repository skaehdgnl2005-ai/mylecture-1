import { describe, it, expect } from 'vitest'
import { costPerImageUsd, estimateCostUsd, sumCostUsd, IMAGE_COST_USD } from './pricing'

describe('costPerImageUsd', () => {
  it('prices each quality from the single table', () => {
    expect(costPerImageUsd('low')).toBe(IMAGE_COST_USD.low)
    expect(costPerImageUsd('medium')).toBe(IMAGE_COST_USD.medium)
    expect(costPerImageUsd('high')).toBe(IMAGE_COST_USD.high)
  })

  it('falls back to medium rather than printing $NaN', () => {
    expect(costPerImageUsd('ultra')).toBe(IMAGE_COST_USD.medium)
  })
})

describe('sumCostUsd', () => {
  it('adds the qualities pictures were actually drawn at', () => {
    // 20 drawn at low, then the teacher switched and 5 more at high.
    expect(sumCostUsd({ low: 20, high: 5 }, 'high')).toBe(
      Math.round((20 * IMAGE_COST_USD.low + 5 * IMAGE_COST_USD.high) * 100) / 100,
    )
  })

  /**
   * The regression this whole change exists for. The teacher taps 높음 at
   * minute 8; the 20 pictures drawn in minutes 0-7 were low and stay low.
   * The old `estimateCostUsd(done, session.image_quality)` re-priced all 20.
   */
  it('does not re-price finished pictures when quality changes mid-lesson', () => {
    const drawnAtLow = { low: 20 }

    const beforeSwitch = sumCostUsd(drawnAtLow, 'low')
    const afterSwitch = sumCostUsd(drawnAtLow, 'high')
    expect(afterSwitch).toBe(beforeSwitch)

    // And it is genuinely different from what the old code produced.
    expect(estimateCostUsd(20, 'high')).toBeGreaterThan(afterSwitch * 10)
  })

  it("prices the 'unknown' bucket at the session's quality", () => {
    // Rows finished before 0008 started writing the column.
    expect(sumCostUsd({ unknown: 10 }, 'low')).toBe(estimateCostUsd(10, 'low'))
    expect(sumCostUsd({ unknown: 10 }, 'high')).toBe(estimateCostUsd(10, 'high'))
  })

  it('mixes known rows with unknown ones', () => {
    expect(sumCostUsd({ low: 10, unknown: 10 }, 'high')).toBe(
      Math.round((10 * IMAGE_COST_USD.low + 10 * IMAGE_COST_USD.high) * 100) / 100,
    )
  })

  it('is zero before anything is drawn', () => {
    expect(sumCostUsd({}, 'medium')).toBe(0)
  })

  it('ignores junk counts instead of producing NaN', () => {
    expect(sumCostUsd({ low: 0, medium: -3, high: Number.NaN }, 'medium')).toBe(0)
  })

  it('agrees with estimateCostUsd when nothing has changed quality', () => {
    // The forward estimate stays correct for a session that never switched.
    expect(sumCostUsd({ medium: 40 }, 'medium')).toBe(estimateCostUsd(40, 'medium'))
  })
})
