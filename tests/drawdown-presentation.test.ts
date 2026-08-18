import { describe, expect, it } from 'vitest'
import { drawdownMetricPresentation } from '../src/lib/drawdown-presentation'
import type { DrawdownSummary } from '../src/lib/time-weighted-performance'

function drawdown(overrides: Partial<DrawdownSummary> = {}): DrawdownSummary {
  return {
    maximumDrawdown: null,
    peakDate: null,
    troughDate: null,
    declineDays: null,
    recoveryDate: null,
    recoveryDays: null,
    underwaterDays: null,
    currentDrawdown: null,
    currentlyInDrawdown: null,
    currentPeakDate: null,
    currentUnderwaterDays: null,
    ...overrides,
  }
}

describe('drawdown metric presentation', () => {
  it('does not claim recovery or an unrecovered drawdown when calculation is blocked', () => {
    expect(drawdownMetricPresentation(false, drawdown())).toEqual({
      currentDrawdownHint: '回撤資料尚不能完整計算',
      recoveryDateValue: '—',
      underwaterHint: undefined,
    })
  })

  it('reports recovery only for a complete drawdown calculation', () => {
    expect(drawdownMetricPresentation(true, drawdown({
      currentlyInDrawdown: false,
      currentDrawdown: 0,
      recoveryDate: '2026-01-03',
      underwaterDays: 2,
    }))).toEqual({
      currentDrawdownHint: '目前已回到歷史高點',
      recoveryDateValue: '2026-01-03',
      underwaterHint: '自前高至修復；未修復則算到最新點',
    })
  })

  it('reports an unrecovered drawdown only for a complete active drawdown', () => {
    expect(drawdownMetricPresentation(true, drawdown({
      maximumDrawdown: -0.2,
      currentDrawdown: -0.1,
      currentlyInDrawdown: true,
      currentUnderwaterDays: 5,
      underwaterDays: 5,
    }))).toEqual({
      currentDrawdownHint: '仍在回撤，已 5 天',
      recoveryDateValue: '尚未修復',
      underwaterHint: '自前高至修復；未修復則算到最新點',
    })
  })
})
