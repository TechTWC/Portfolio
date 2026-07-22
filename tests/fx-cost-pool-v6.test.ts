import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import { buildFxCostPool } from '../src/lib/fx-cost-pool'

function row(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    sourceRowNumber: 2,
    tradeDate: '2026-01-01',
    transactionType: 'CASH_IN',
    ticker: '',
    currency: 'TWD',
    quantity: 0,
    price: 0,
    amountForeign: 100_000,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: 'b'.repeat(64),
    ...overrides,
  }
}

describe('Revision 6 synthetic FX cost basis', () => {
  it('matches the accepted transaction and funding sequence', () => {
    const result = buildFxCostPool([
      row({ sourceRowNumber: 2, tradeDate: '2026-01-01' }),
      row({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'FX_BUY',
        currency: 'USD',
        amountForeign: 2_000,
        fxRate: 32,
        fee: 100,
      }),
      row({
        sourceRowNumber: 4,
        tradeDate: '2026-01-05',
        transactionType: 'SECURITY',
        ticker: '2330.TW',
        currency: 'TWD',
        quantity: 10,
        price: 1_000,
        amountForeign: 10_000,
      }),
      row({
        sourceRowNumber: 5,
        tradeDate: '2026-02-03',
        transactionType: 'SECURITY',
        ticker: 'AAPL',
        currency: 'USD',
        quantity: 2,
        price: 200,
        amountForeign: 400,
        fxRate: 32.5,
      }),
      row({
        sourceRowNumber: 6,
        tradeDate: '2026-03-10',
        transactionType: 'SECURITY',
        ticker: '2330.TW',
        currency: 'TWD',
        quantity: -2,
        price: 1_100,
        amountForeign: 2_200,
      }),
      row({
        sourceRowNumber: 7,
        tradeDate: '2026-04-15',
        transactionType: 'SECURITY',
        ticker: 'MSFT',
        currency: 'USD',
        quantity: 1,
        price: 500,
        amountForeign: 500,
        fxRate: 33,
      }),
      row({
        sourceRowNumber: 8,
        tradeDate: '2026-05-20',
        transactionType: 'SECURITY',
        ticker: 'NVDA',
        currency: 'USD',
        quantity: 1,
        price: 150,
        amountForeign: 150,
        fxRate: 33.2,
      }),
      row({
        sourceRowNumber: 9,
        tradeDate: '2026-06-10',
        transactionType: 'SECURITY',
        ticker: 'GOOG',
        currency: 'USD',
        quantity: 1,
        price: 1_000,
        amountForeign: 1_000,
        fxRate: 33.5,
        fee: 5,
      }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.pools).toEqual([
      expect.objectContaining({
        currency: 'USD',
        units: 0,
        twdCostBasis: 0,
        explicitFxUnitsIn: 2_000,
        automaticUnitsIn: 55,
        unitsAssignedToSecurities: 2_055,
      }),
    ])

    const byTicker = Object.fromEntries(result.positions.map((position) => [position.ticker, position]))
    expect(byTicker['2330.TW']).toMatchObject({ quantity: 8, twdCostBasis: 8_000, realizedPnlTwd: 200 })
    expect(byTicker.AAPL.twdCostBasis).toBeCloseTo(12_820, 10)
    expect(byTicker.MSFT.twdCostBasis).toBeCloseTo(16_025, 10)
    expect(byTicker.NVDA.twdCostBasis).toBeCloseTo(4_807.5, 10)
    expect(byTicker.GOOG.twdCostBasis).toBeCloseTo(32_290, 10)

    const totalTwdPositionBasis = result.positions.reduce((total, position) => total + position.twdCostBasis, 0)
    expect(totalTwdPositionBasis).toBeCloseTo(73_942.5, 10)
  })
})
