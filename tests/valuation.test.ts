import { describe, expect, it } from 'vitest'
import type { PositionAccounting } from '../src/lib/accounting'
import type { CashWallet } from '../src/lib/cash-ledger'
import { buildPointInTimeValuation, type ValuationMark } from '../src/lib/valuation'

function position(overrides: Partial<PositionAccounting>): PositionAccounting {
  return {
    ticker: 'TEST',
    currency: 'TWD',
    quantity: 1,
    costBasis: 100,
    averageUnitCost: 100,
    realizedPnl: 0,
    grossBuys: 100,
    grossSells: 0,
    fees: 0,
    tradeCount: 1,
    ...overrides,
  }
}

function wallet(overrides: Partial<CashWallet>): CashWallet {
  return {
    currency: 'TWD',
    deposits: 0,
    withdrawals: 0,
    explicitFxIn: 0,
    explicitFxOut: 0,
    autoFundedIn: 0,
    autoFundingOut: 0,
    securitySpent: 0,
    securityReceived: 0,
    fees: 0,
    endingBalance: 0,
    ...overrides,
  }
}

function mark(overrides: Partial<ValuationMark>): ValuationMark {
  return {
    sourceRowNumber: 2,
    markDate: '2026-06-30',
    markType: 'PRICE',
    ticker: 'TEST',
    currency: 'TWD',
    value: 100,
    source: 'GOLDEN',
    ...overrides,
  }
}

describe('point-in-time valuation core', () => {
  it('matches the accepted Revision 6 golden snapshot', () => {
    const result = buildPointInTimeValuation({
      valuationDate: '2026-06-30',
      positions: [
        position({ ticker: '2330.TW', currency: 'TWD', quantity: 8, costBasis: 8_000, averageUnitCost: 1_000 }),
        position({ ticker: 'AAPL', currency: 'USD', quantity: 2, costBasis: 400, averageUnitCost: 200 }),
        position({ ticker: 'GOOG', currency: 'USD', quantity: 1, costBasis: 1_005, averageUnitCost: 1_005 }),
        position({ ticker: 'MSFT', currency: 'USD', quantity: 1, costBasis: 500, averageUnitCost: 500 }),
        position({ ticker: 'NVDA', currency: 'USD', quantity: 1, costBasis: 150, averageUnitCost: 150 }),
      ],
      wallets: [
        wallet({ currency: 'TWD', endingBalance: 26_257.5 }),
        wallet({ currency: 'USD', endingBalance: 0 }),
      ],
      marks: [
        mark({ sourceRowNumber: 2, ticker: '2330.TW', currency: 'TWD', value: 1_100 }),
        mark({ sourceRowNumber: 3, ticker: 'AAPL', currency: 'USD', value: 250 }),
        mark({ sourceRowNumber: 4, ticker: 'GOOG', currency: 'USD', value: 1_050 }),
        mark({ sourceRowNumber: 5, ticker: 'MSFT', currency: 'USD', value: 550 }),
        mark({ sourceRowNumber: 6, ticker: 'NVDA', currency: 'USD', value: 160 }),
        mark({ sourceRowNumber: 7, markType: 'FX', ticker: '', currency: 'USD', value: 33 }),
      ],
    })

    expect(result.complete).toBe(true)
    expect(result.blockingIssueCount).toBe(0)
    expect(result.knownPositionValueTwd).toBeCloseTo(83_380, 10)
    expect(result.knownCashValueTwd).toBeCloseTo(26_257.5, 10)
    expect(result.totalAssetsTwd).toBeCloseTo(109_637.5, 10)

    expect(result.positions.find((row) => row.ticker === '2330.TW')).toMatchObject({
      marketValueNative: 8_800,
      unrealizedPnlNative: 800,
      marketValueTwd: 8_800,
      fxRate: 1,
    })
    expect(result.positions.find((row) => row.ticker === 'AAPL')).toMatchObject({
      marketValueNative: 500,
      unrealizedPnlNative: 100,
      marketValueTwd: 16_500,
      fxRate: 33,
    })
    expect(result.positions.find((row) => row.ticker === 'GOOG')?.unrealizedPnlNative).toBe(45)
    expect(result.positions.find((row) => row.ticker === 'MSFT')?.unrealizedPnlNative).toBe(50)
    expect(result.positions.find((row) => row.ticker === 'NVDA')?.unrealizedPnlNative).toBe(10)
  })

  it('uses the latest mark on or before the valuation date and ignores the future', () => {
    const result = buildPointInTimeValuation({
      valuationDate: '2026-06-30',
      positions: [position({ ticker: '2330.TW' })],
      wallets: [],
      marks: [
        mark({ sourceRowNumber: 2, markDate: '2026-06-29', ticker: '2330.TW', value: 110 }),
        mark({ sourceRowNumber: 3, markDate: '2026-07-01', ticker: '2330.TW', value: 999 }),
      ],
    })

    expect(result.complete).toBe(true)
    expect(result.futureMarkCount).toBe(1)
    expect(result.positions[0].price).toBe(110)
    expect(result.positions[0].priceDate).toBe('2026-06-29')
    expect(result.positions[0].marketValueTwd).toBe(110)
  })

  it('is incomplete when a foreign position has no point-in-time FX mark', () => {
    const result = buildPointInTimeValuation({
      valuationDate: '2026-06-30',
      positions: [position({ ticker: 'AAPL', currency: 'USD' })],
      wallets: [],
      marks: [mark({ ticker: 'AAPL', currency: 'USD', value: 250 })],
    })

    expect(result.complete).toBe(false)
    expect(result.totalAssetsTwd).toBeNull()
    expect(result.issues.some((issue) => issue.code === 'MISSING_FX')).toBe(true)
    expect(result.positions[0].marketValueNative).toBe(250)
    expect(result.positions[0].marketValueTwd).toBeNull()
  })

  it('blocks conflicting latest marks instead of selecting one arbitrarily', () => {
    const result = buildPointInTimeValuation({
      valuationDate: '2026-06-30',
      positions: [position({ ticker: '2330.TW' })],
      wallets: [],
      marks: [
        mark({ sourceRowNumber: 2, ticker: '2330.TW', value: 100, source: 'SOURCE_A' }),
        mark({ sourceRowNumber: 3, ticker: '2330.TW', value: 101, source: 'SOURCE_B' }),
      ],
    })

    expect(result.complete).toBe(false)
    expect(result.issues.some((issue) => issue.code === 'CONFLICTING_MARK')).toBe(true)
    expect(result.positions[0].price).toBeNull()
  })

  it('does not require an FX mark for a zero foreign-currency cash balance', () => {
    const result = buildPointInTimeValuation({
      valuationDate: '2026-06-30',
      positions: [],
      wallets: [wallet({ currency: 'USD', endingBalance: 0 })],
      marks: [],
    })

    expect(result.complete).toBe(true)
    expect(result.totalAssetsTwd).toBe(0)
    expect(result.issues).toEqual([])
  })
})
