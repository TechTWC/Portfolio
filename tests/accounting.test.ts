import { describe, expect, it } from 'vitest'
import { buildPortfolioAccounting } from '../src/lib/accounting'
import type { NormalizedTransaction } from '../src/lib/contracts'

function transaction(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    sourceRowNumber: 2,
    tradeDate: '2026-01-01',
    transactionType: 'SECURITY',
    ticker: 'TEST',
    currency: 'TWD',
    quantity: 1,
    price: 100,
    amountForeign: 100,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: 'a'.repeat(64),
    ...overrides,
  }
}

describe('portfolio accounting core', () => {
  it('includes buy fees in moving-average cost basis', () => {
    const result = buildPortfolioAccounting([
      transaction({ quantity: 10, amountForeign: 10_000, fee: 20 }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.positions).toHaveLength(1)
    expect(result.positions[0]).toMatchObject({
      quantity: 10,
      costBasis: 10_020,
      averageUnitCost: 1_002,
      realizedPnl: 0,
    })
    expect(result.currencies[0]).toMatchObject({
      currency: 'TWD',
      grossBuys: 10_000,
      fees: 20,
      netSecurityCashFlow: -10_020,
    })
  })

  it('releases moving-average cost basis on a partial sell', () => {
    const result = buildPortfolioAccounting([
      transaction({ sourceRowNumber: 2, tradeDate: '2026-01-01', quantity: 10, amountForeign: 10_000, fee: 20 }),
      transaction({ sourceRowNumber: 3, tradeDate: '2026-01-02', quantity: 10, amountForeign: 12_000, fee: 20 }),
      transaction({ sourceRowNumber: 4, tradeDate: '2026-01-03', quantity: -5, amountForeign: 6_500, fee: 10 }),
    ])

    expect(result.positions[0].quantity).toBe(15)
    expect(result.positions[0].averageUnitCost).toBeCloseTo(1_102, 10)
    expect(result.positions[0].costBasis).toBeCloseTo(16_530, 10)
    expect(result.positions[0].realizedPnl).toBeCloseTo(980, 10)
    expect(result.currencies[0]).toMatchObject({
      grossBuys: 22_000,
      grossSells: 6_500,
      fees: 50,
      netSecurityCashFlow: -15_550,
      realizedPnl: 980,
    })
  })

  it('blocks an oversell without creating a negative position', () => {
    const result = buildPortfolioAccounting([
      transaction({ sourceRowNumber: 2, quantity: 2, amountForeign: 200 }),
      transaction({ sourceRowNumber: 3, tradeDate: '2026-01-02', quantity: -3, amountForeign: 330 }),
    ])

    expect(result.blockingIssueCount).toBe(1)
    expect(result.issues[0].code).toBe('OVERSELL')
    expect(result.positions[0]).toMatchObject({ quantity: 2, costBasis: 200, grossSells: 0 })
    expect(result.currencies[0].netSecurityCashFlow).toBe(-200)
  })

  it('keeps TWD and USD accounting separate', () => {
    const result = buildPortfolioAccounting([
      transaction({ ticker: '2330.TW', currency: 'TWD', quantity: 10, amountForeign: 10_000 }),
      transaction({ sourceRowNumber: 3, ticker: 'AAPL', currency: 'USD', fxRate: 32.5, quantity: 2, amountForeign: 400 }),
    ])

    expect(result.positions.map((position) => `${position.currency}:${position.ticker}`)).toEqual([
      'TWD:2330.TW',
      'USD:AAPL',
    ])
    expect(result.currencies).toEqual([
      expect.objectContaining({ currency: 'TWD', netSecurityCashFlow: -10_000 }),
      expect.objectContaining({ currency: 'USD', netSecurityCashFlow: -400 }),
    ])
  })

  it('processes transactions by date and source row, not input order', () => {
    const result = buildPortfolioAccounting([
      transaction({ sourceRowNumber: 3, tradeDate: '2026-01-02', quantity: -1, amountForeign: 120 }),
      transaction({ sourceRowNumber: 2, tradeDate: '2026-01-01', quantity: 1, amountForeign: 100 }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.positions[0].quantity).toBe(0)
    expect(result.positions[0].realizedPnl).toBe(20)
  })

  it('leaves cash and FX rows to cash-ledger v0.2 without stale warnings', () => {
    const result = buildPortfolioAccounting([
      transaction({ transactionType: 'CASH_IN', ticker: '', currency: 'TWD', quantity: 0, price: 0, amountForeign: 100_000 }),
      transaction({ sourceRowNumber: 3, transactionType: 'FX_BUY', ticker: '', currency: 'USD', quantity: 0, price: 0, amountForeign: 2_000, fxRate: 32 }),
      transaction({ sourceRowNumber: 4, tradeDate: '2026-01-02', ticker: 'AAPL', currency: 'USD', quantity: 1, price: 200, amountForeign: 200 }),
    ])

    expect(result.deferredTransactionCount).toBe(2)
    expect(result.issues).toEqual([])
    expect(result.positions[0]).toMatchObject({ ticker: 'AAPL', quantity: 1, costBasis: 200 })
  })
})
