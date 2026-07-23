import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
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

function transaction(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    sourceRowNumber: 2,
    tradeDate: '2026-01-01',
    transactionType: 'CASH_IN',
    ticker: '',
    currency: 'TWD',
    quantity: 0,
    price: 0,
    amountForeign: 10_000,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: 'f'.repeat(64),
    ...overrides,
  }
}

describe('historical NAV schedule derivation', () => {
  it('uses unique sorted PRICE dates, inception, and the active valuation date', () => {
    expect(deriveHistoricalNavDates([
      mark({ markDate: '2026-03-31' }),
      mark({ sourceRowNumber: 3, markDate: '2026-01-31' }),
      mark({ sourceRowNumber: 4, markDate: '2026-01-31', ticker: 'OTHER' }),
      mark({ sourceRowNumber: 5, markDate: '2026-02-28', markType: 'FX', ticker: '', currency: 'USD', value: 32 }),
    ], '2026-06-30', [
      transaction({ tradeDate: '2026-01-01' }),
      transaction({ sourceRowNumber: 3, tradeDate: '2026-04-01', transactionType: 'SECURITY', ticker: 'TEST', quantity: 1, price: 100, amountForeign: 100 }),
    ])).toEqual(['2026-01-01', '2026-01-31', '2026-03-31', '2026-06-30'])
  })

  it('still includes inception and active valuation dates for a cash-only portfolio', () => {
    expect(deriveHistoricalNavDates([], '2026-06-30', [
      transaction({ tradeDate: '2026-01-01' }),
    ])).toEqual(['2026-01-01', '2026-06-30'])
  })

  it('ignores invalid dates', () => {
    expect(deriveHistoricalNavDates([
      mark({ markDate: 'invalid' }),
      mark({ sourceRowNumber: 3, markDate: '2026-02-30' }),
    ], 'invalid', [
      transaction({ tradeDate: 'invalid' }),
    ])).toEqual([])
  })
})
