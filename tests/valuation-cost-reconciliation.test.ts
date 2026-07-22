import { describe, expect, it } from 'vitest'
import type { FxCostPoolResult } from '../src/lib/fx-cost-pool'
import type { PointInTimeValuation } from '../src/lib/valuation'
import { reconcileValuationWithTwdCost } from '../src/lib/valuation-cost-reconciliation'

const valuation: PointInTimeValuation = {
  valuationDate: '2026-06-30',
  baseCurrency: 'TWD',
  complete: true,
  blockingIssueCount: 0,
  futureMarkCount: 0,
  knownPositionValueTwd: 83_380,
  knownCashValueTwd: 26_257.5,
  knownTotalAssetsTwd: 109_637.5,
  totalAssetsTwd: 109_637.5,
  issues: [],
  cash: [
    { currency: 'TWD', endingBalance: 26_257.5, fxRate: 1, fxDate: '2026-06-30', fxSource: 'TEST', marketValueTwd: 26_257.5 },
    { currency: 'USD', endingBalance: 0, fxRate: 33, fxDate: '2026-06-30', fxSource: 'TEST', marketValueTwd: 0 },
  ],
  positions: [
    { ticker: '2330.TW', currency: 'TWD', quantity: 8, costBasis: 8_000, price: 1_100, priceDate: '2026-06-30', priceSource: 'TEST', marketValueNative: 8_800, unrealizedPnlNative: 800, fxRate: 1, fxDate: '2026-06-30', fxSource: 'TEST', marketValueTwd: 8_800 },
    { ticker: 'AAPL', currency: 'USD', quantity: 2, costBasis: 400, price: 250, priceDate: '2026-06-30', priceSource: 'TEST', marketValueNative: 500, unrealizedPnlNative: 100, fxRate: 33, fxDate: '2026-06-30', fxSource: 'TEST', marketValueTwd: 16_500 },
    { ticker: 'GOOG', currency: 'USD', quantity: 1, costBasis: 1_005, price: 1_050, priceDate: '2026-06-30', priceSource: 'TEST', marketValueNative: 1_050, unrealizedPnlNative: 45, fxRate: 33, fxDate: '2026-06-30', fxSource: 'TEST', marketValueTwd: 34_650 },
    { ticker: 'MSFT', currency: 'USD', quantity: 1, costBasis: 500, price: 550, priceDate: '2026-06-30', priceSource: 'TEST', marketValueNative: 550, unrealizedPnlNative: 50, fxRate: 33, fxDate: '2026-06-30', fxSource: 'TEST', marketValueTwd: 18_150 },
    { ticker: 'NVDA', currency: 'USD', quantity: 1, costBasis: 150, price: 160, priceDate: '2026-06-30', priceSource: 'TEST', marketValueNative: 160, unrealizedPnlNative: 10, fxRate: 33, fxDate: '2026-06-30', fxSource: 'TEST', marketValueTwd: 5_280 },
  ],
}

const cost: FxCostPoolResult = {
  method: 'MOVING_AVERAGE',
  blockingIssueCount: 0,
  issues: [],
  pools: [{
    currency: 'USD',
    units: 0,
    twdCostBasis: 0,
    averageFxCost: 0,
    explicitFxUnitsIn: 2_000,
    externalCashUnitsIn: 0,
    automaticUnitsIn: 55,
    unitsAssignedToSecurities: 2_055,
    unitsSoldToTwd: 0,
    unitsWithdrawn: 0,
    foreignFeeUnits: 0,
    foreignFeeTwdCost: 0,
    twdFees: 100,
    realizedFxPnlTwd: 0,
  }],
  positions: [
    { ticker: '2330.TW', currency: 'TWD', quantity: 8, nativeCostBasis: 8_000, twdCostBasis: 8_000, averageNativeUnitCost: 1_000, averageTwdUnitCost: 1_000, realizedPnlTwd: 200, tradeCount: 2 },
    { ticker: 'AAPL', currency: 'USD', quantity: 2, nativeCostBasis: 400, twdCostBasis: 12_820, averageNativeUnitCost: 200, averageTwdUnitCost: 6_410, realizedPnlTwd: 0, tradeCount: 1 },
    { ticker: 'GOOG', currency: 'USD', quantity: 1, nativeCostBasis: 1_005, twdCostBasis: 32_290, averageNativeUnitCost: 1_005, averageTwdUnitCost: 32_290, realizedPnlTwd: 0, tradeCount: 1 },
    { ticker: 'MSFT', currency: 'USD', quantity: 1, nativeCostBasis: 500, twdCostBasis: 16_025, averageNativeUnitCost: 500, averageTwdUnitCost: 16_025, realizedPnlTwd: 0, tradeCount: 1 },
    { ticker: 'NVDA', currency: 'USD', quantity: 1, nativeCostBasis: 150, twdCostBasis: 4_807.5, averageNativeUnitCost: 150, averageTwdUnitCost: 4_807.5, realizedPnlTwd: 0, tradeCount: 1 },
  ],
}

describe('valuation and TWD cost reconciliation', () => {
  it('matches the accepted Revision 6 and valuation v1 golden values', () => {
    const result = reconcileValuationWithTwdCost(valuation, cost)

    expect(result.complete).toBe(true)
    expect(result.totalPositionMarketValueTwd).toBe(83_380)
    expect(result.totalPositionTwdCostBasis).toBe(73_942.5)
    expect(result.totalUnrealizedPnlTwd).toBe(9_437.5)
    expect(result.totalRealizedPnlTwd).toBe(200)
    expect(Object.fromEntries(result.positions.map((position) => [position.ticker, position.unrealizedPnlTwd]))).toEqual({
      '2330.TW': 800,
      AAPL: 3_680,
      GOOG: 2_360,
      MSFT: 2_125,
      NVDA: 472.5,
    })
  })

  it('does not claim completeness when one open position lacks TWD basis', () => {
    const incompleteCost = { ...cost, positions: cost.positions.filter((position) => position.ticker !== 'NVDA') }
    const result = reconcileValuationWithTwdCost(valuation, incompleteCost)

    expect(result.complete).toBe(false)
    expect(result.totalPositionTwdCostBasis).toBeNull()
    expect(result.totalUnrealizedPnlTwd).toBeNull()
    expect(result.missingCostKeys).toEqual(['NVDA:USD'])
  })
})
