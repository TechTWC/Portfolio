import { describe, expect, it } from 'vitest'
import { deriveHistoricalNavDates } from '../src/lib/historical-nav-schedule'
import type { ValuationMark } from '../src/lib/valuation'

function mark(overrides: Partial<ValuationMark>): ValuationMark {
  return {
    sourceRowNumber: 2,
    markDate: '2026-01-31',
    markType: 'PRICE',
    ticker: 'TEST',
    currency: 'TWD',
    value: 100,
    source: 'SYNTHETIC',
    ...overrides,
  }
}

describe('historical NAV schedule derivation', () => {
  it('uses unique sorted PRICE dates and the active valuation date', () => {
    expect(deriveHistoricalNavDates([
      mark({ markDate: '2026-03-31' }),
      mark({ sourceRowNumber: 3, markDate: '2026-01-31' }),
      mark({ sourceRowNumber: 4, markDate: '2026-01-31', ticker: 'OTHER' }),
      mark({ sourceRowNumber: 5, markDate: '2026-02-28', markType: 'FX', ticker: '', currency: 'USD', value: 32 }),
    ], '2026-06-30')).toEqual(['2026-01-31', '2026-03-31', '2026-06-30'])
  })

  it('still includes the active valuation date for a cash-only portfolio', () => {
    expect(deriveHistoricalNavDates([], '2026-06-30')).toEqual(['2026-06-30'])
  })

  it('ignores invalid dates', () => {
    expect(deriveHistoricalNavDates([
      mark({ markDate: 'invalid' }),
      mark({ sourceRowNumber: 3, markDate: '2026-02-30' }),
    ], 'invalid')).toEqual([])
  })
})
