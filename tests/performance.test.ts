import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import { buildCurrentPerformance } from '../src/lib/performance'

function row(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    sourceRowNumber: 2,
    tradeDate: '2026-01-01',
    transactionType: 'CASH_IN',
    ticker: '',
    currency: 'TWD',
    quantity: 0,
    price: 0,
    amountForeign: 100,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: 'c'.repeat(64),
    ...overrides,
  }
}

describe('external cash flow and XIRR performance', () => {
  it('matches the accepted Revision 6 and valuation Snapshot v1 result', () => {
    const result = buildCurrentPerformance({
      transactions: [
        row({ amountForeign: 100_000 }),
        row({ sourceRowNumber: 3, tradeDate: '2026-01-02', transactionType: 'FX_BUY', currency: 'USD', amountForeign: 2_000, fxRate: 32, fee: 100 }),
        row({ sourceRowNumber: 4, tradeDate: '2026-01-05', transactionType: 'SECURITY', ticker: '2330.TW', quantity: 10, price: 1_000, amountForeign: 10_000 }),
        row({ sourceRowNumber: 5, tradeDate: '2026-02-03', transactionType: 'SECURITY', ticker: 'AAPL', currency: 'USD', quantity: 2, price: 200, amountForeign: 400, fxRate: 32.5 }),
      ],
      valuationDate: '2026-06-30',
      valuationComplete: true,
      terminalAssetsTwd: 109_637.5,
    })

    expect(result.complete).toBe(true)
    expect(result.blockingIssueCount).toBe(0)
    expect(result.grossContributionsTwd).toBe(100_000)
    expect(result.grossWithdrawalsTwd).toBe(0)
    expect(result.netContributedCapitalTwd).toBe(100_000)
    expect(result.cumulativeProfitTwd).toBe(9_637.5)
    expect(result.moneyMultiple).toBeCloseTo(1.096375, 12)
    expect(result.xirr).toBeCloseTo(0.20511425515474535, 9)
    expect(result.externalCashFlows).toEqual([
      expect.objectContaining({ date: '2026-01-01', kind: 'CONTRIBUTION', signedAmountTwd: -100_000 }),
      expect.objectContaining({ date: '2026-06-30', kind: 'TERMINAL_VALUE', signedAmountTwd: 109_637.5 }),
    ])
  })

  it('calculates a 10 percent one-year XIRR', () => {
    const result = buildCurrentPerformance({
      transactions: [row({ amountForeign: 100 })],
      valuationDate: '2027-01-01',
      valuationComplete: true,
      terminalAssetsTwd: 110,
    })

    expect(result.complete).toBe(true)
    expect(result.xirr).toBeCloseTo(0.1, 10)
  })

  it('converts foreign external cash flows using their historical row FX rates', () => {
    const result = buildCurrentPerformance({
      transactions: [
        row({ currency: 'USD', amountForeign: 100, fxRate: 30 }),
        row({
          sourceRowNumber: 3,
          tradeDate: '2026-06-01',
          transactionType: 'CASH_OUT',
          currency: 'USD',
          amountForeign: 20,
          fxRate: 35,
        }),
      ],
      valuationDate: '2027-01-01',
      valuationComplete: true,
      terminalAssetsTwd: 2_500,
    })

    expect(result.grossContributionsTwd).toBe(3_000)
    expect(result.grossWithdrawalsTwd).toBe(700)
    expect(result.netContributedCapitalTwd).toBe(2_300)
    expect(result.cumulativeProfitTwd).toBe(200)
  })

  it('blocks a foreign external flow with no historical FX rate', () => {
    const result = buildCurrentPerformance({
      transactions: [row({ currency: 'USD', amountForeign: 100, fxRate: null })],
      valuationDate: '2027-01-01',
      valuationComplete: true,
      terminalAssetsTwd: 3_500,
    })

    expect(result.complete).toBe(false)
    expect(result.issues.some((issue) => issue.code === 'MISSING_EXTERNAL_FLOW_FX')).toBe(true)
  })

  it('blocks when the ACTIVE transaction set extends beyond the valuation date', () => {
    const result = buildCurrentPerformance({
      transactions: [
        row({ amountForeign: 100 }),
        row({ sourceRowNumber: 3, tradeDate: '2026-07-01', transactionType: 'SECURITY', ticker: 'LATE', quantity: 1, price: 10, amountForeign: 10 }),
      ],
      valuationDate: '2026-06-30',
      valuationComplete: true,
      terminalAssetsTwd: 110,
    })

    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'TRANSACTION_AFTER_VALUATION_DATE',
      sourceRowNumbers: [3],
    }))
  })

  it('blocks incomplete valuation instead of using known partial assets', () => {
    const result = buildCurrentPerformance({
      transactions: [row({ amountForeign: 100 })],
      valuationDate: '2027-01-01',
      valuationComplete: false,
      terminalAssetsTwd: null,
    })

    expect(result.complete).toBe(false)
    expect(result.issues.some((issue) => issue.code === 'INCOMPLETE_VALUATION')).toBe(true)
    expect(result.xirr).toBeNull()
  })

  it('blocks a zero-day investment period', () => {
    const result = buildCurrentPerformance({
      transactions: [row({ amountForeign: 100 })],
      valuationDate: '2026-01-01',
      valuationComplete: true,
      terminalAssetsTwd: 110,
    })

    expect(result.complete).toBe(false)
    expect(result.issues.some((issue) => issue.code === 'ZERO_TIME_SPAN')).toBe(true)
  })

  it('blocks multiple XIRR roots instead of selecting one silently', () => {
    const result = buildCurrentPerformance({
      transactions: [
        row({ tradeDate: '2026-01-01', amountForeign: 100 }),
        row({ sourceRowNumber: 3, tradeDate: '2027-01-01', transactionType: 'CASH_OUT', amountForeign: 230 }),
        row({ sourceRowNumber: 4, tradeDate: '2028-01-01', transactionType: 'CASH_IN', amountForeign: 132 }),
      ],
      valuationDate: '2028-01-01',
      valuationComplete: true,
      terminalAssetsTwd: 0,
    })

    expect(result.complete).toBe(false)
    expect(result.xirr).toBeNull()
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'MULTIPLE_XIRR_ROOTS' }))
  })
})
