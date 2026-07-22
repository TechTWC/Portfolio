import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import { buildFxCostPool } from '../src/lib/fx-cost-pool'

function transaction(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    sourceRowNumber: 2,
    tradeDate: '2026-01-01',
    transactionType: 'FX_BUY',
    ticker: '',
    currency: 'USD',
    quantity: 0,
    price: 0,
    amountForeign: 100,
    fxRate: 32,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: 'a'.repeat(64),
    ...overrides,
  }
}

describe('foreign currency moving-average cost pool', () => {
  it('calculates the weighted-average TWD cost of two FX purchases', () => {
    const result = buildFxCostPool([
      transaction({ sourceRowNumber: 2, amountForeign: 1_000, fxRate: 32 }),
      transaction({ sourceRowNumber: 3, tradeDate: '2026-01-02', amountForeign: 1_000, fxRate: 34 }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.pools[0]).toMatchObject({
      currency: 'USD',
      units: 2_000,
      twdCostBasis: 66_000,
      averageFxCost: 33,
      explicitFxUnitsIn: 2_000,
    })
  })

  it('assigns released pool cost to a foreign security purchase', () => {
    const result = buildFxCostPool([
      transaction({ sourceRowNumber: 2, amountForeign: 1_000, fxRate: 32 }),
      transaction({ sourceRowNumber: 3, tradeDate: '2026-01-02', amountForeign: 1_000, fxRate: 34 }),
      transaction({
        sourceRowNumber: 4,
        tradeDate: '2026-01-03',
        transactionType: 'SECURITY',
        ticker: 'TEST',
        quantity: 6,
        price: 200,
        amountForeign: 1_200,
        fxRate: null,
      }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.pools[0]).toMatchObject({
      units: 800,
      twdCostBasis: 26_400,
      averageFxCost: 33,
      unitsAssignedToSecurities: 1_200,
    })
    expect(result.positions[0]).toMatchObject({
      ticker: 'TEST',
      currency: 'USD',
      quantity: 6,
      nativeCostBasis: 1_200,
      twdCostBasis: 39_600,
      averageNativeUnitCost: 200,
      averageTwdUnitCost: 6_600,
    })
  })

  it('adds an exact automatic FX shortfall before consuming the pool', () => {
    const result = buildFxCostPool([
      transaction({ sourceRowNumber: 2, amountForeign: 100, fxRate: 30 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'SECURITY',
        ticker: 'AUTO',
        quantity: 1,
        price: 145,
        amountForeign: 145,
        fxRate: 40,
        fee: 5,
      }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.pools[0]).toMatchObject({
      units: 0,
      twdCostBasis: 0,
      automaticUnitsIn: 50,
      unitsAssignedToSecurities: 150,
    })
    expect(result.positions[0]).toMatchObject({
      nativeCostBasis: 150,
      twdCostBasis: 5_000,
      averageTwdUnitCost: 5_000,
    })
  })

  it('releases proportional native and TWD security basis on a partial sale', () => {
    const result = buildFxCostPool([
      transaction({ sourceRowNumber: 2, amountForeign: 1_000, fxRate: 32 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'SECURITY',
        ticker: 'PARTIAL',
        quantity: 10,
        price: 100,
        amountForeign: 1_000,
        fxRate: null,
      }),
      transaction({
        sourceRowNumber: 4,
        tradeDate: '2026-01-03',
        transactionType: 'SECURITY',
        ticker: 'PARTIAL',
        quantity: -4,
        price: 120,
        amountForeign: 480,
        fxRate: 33,
        fee: 20,
      }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.positions[0].quantity).toBe(6)
    expect(result.positions[0].nativeCostBasis).toBeCloseTo(600, 10)
    expect(result.positions[0].twdCostBasis).toBeCloseTo(19_200, 10)
    expect(result.positions[0].realizedPnlTwd).toBeCloseTo(2_380, 10)
    expect(result.pools[0]).toMatchObject({
      units: 460,
      twdCostBasis: 15_180,
      averageFxCost: 33,
    })
  })

  it('calculates realized FX P&L on a direct FX sale', () => {
    const result = buildFxCostPool([
      transaction({ sourceRowNumber: 2, amountForeign: 1_000, fxRate: 32, fee: 100 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'FX_SELL',
        amountForeign: 400,
        fxRate: 34,
        fee: 50,
      }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.pools[0].units).toBeCloseTo(600, 10)
    expect(result.pools[0].twdCostBasis).toBeCloseTo(19_260, 10)
    expect(result.pools[0].averageFxCost).toBeCloseTo(32.1, 10)
    expect(result.pools[0].realizedFxPnlTwd).toBeCloseTo(710, 10)
  })

  it('records a foreign cash-in fee as units and TWD cost outside the remaining pool', () => {
    const result = buildFxCostPool([
      transaction({
        sourceRowNumber: 2,
        transactionType: 'CASH_IN',
        amountForeign: 1_000,
        fxRate: 32,
        fee: 10,
      }),
    ])

    expect(result.blockingIssueCount).toBe(0)
    expect(result.pools[0]).toMatchObject({
      units: 990,
      twdCostBasis: 31_680,
      averageFxCost: 32,
      externalCashUnitsIn: 990,
      foreignFeeUnits: 10,
      foreignFeeTwdCost: 320,
    })
  })

  it('blocks an outflow larger than the available foreign pool', () => {
    const result = buildFxCostPool([
      transaction({ sourceRowNumber: 2, amountForeign: 100, fxRate: 32 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'CASH_OUT',
        amountForeign: 120,
        fxRate: null,
      }),
    ])

    expect(result.blockingIssueCount).toBe(1)
    expect(result.issues[0]).toMatchObject({
      code: 'INSUFFICIENT_FOREIGN_POOL',
      required: 120,
      available: 100,
    })
    expect(result.pools[0]).toMatchObject({ units: 100, twdCostBasis: 3_200 })
  })

  it('blocks a foreign security sale when the sale-date FX rate is missing', () => {
    const result = buildFxCostPool([
      transaction({ sourceRowNumber: 2, amountForeign: 500, fxRate: 32 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'SECURITY',
        ticker: 'NOFX',
        quantity: 5,
        price: 100,
        amountForeign: 500,
        fxRate: null,
      }),
      transaction({
        sourceRowNumber: 4,
        tradeDate: '2026-01-03',
        transactionType: 'SECURITY',
        ticker: 'NOFX',
        quantity: -2,
        price: 120,
        amountForeign: 240,
        fxRate: null,
      }),
    ])

    expect(result.blockingIssueCount).toBe(1)
    expect(result.issues[0].code).toBe('MISSING_SECURITY_SALE_FX')
    expect(result.positions[0]).toMatchObject({
      quantity: 5,
      nativeCostBasis: 500,
      twdCostBasis: 16_000,
      realizedPnlTwd: 0,
    })
  })

  it('is deterministic after chronological sorting regardless of input order', () => {
    const buyFx = transaction({ sourceRowNumber: 2, tradeDate: '2026-01-01', amountForeign: 500, fxRate: 32 })
    const buyStock = transaction({
      sourceRowNumber: 3,
      tradeDate: '2026-01-02',
      transactionType: 'SECURITY',
      ticker: 'ORDER',
      quantity: 2,
      price: 200,
      amountForeign: 400,
      fxRate: null,
    })

    expect(buildFxCostPool([buyFx, buyStock])).toEqual(buildFxCostPool([buyStock, buyFx]))
  })
})
