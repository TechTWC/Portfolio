import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import {
  buildMonthlySchedule,
  buildStrategyComparisonCore,
} from '../src/lib/strategy-comparison'
import type { StrategyComparisonRequest } from '../src/lib/strategy-comparison-contracts'

function row(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    sourceRowNumber: 2,
    tradeDate: '2026-01-01',
    transactionType: 'SECURITY',
    ticker: 'ORIGINAL',
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

const request: StrategyComparisonRequest = {
  startDate: '2026-01-01',
  endDate: '2026-04-01',
  dcaMonthlyAmountTwd: 100,
  allocations: [{ ticker: 'AAA', weight: 1 }],
}

const priceSeries = [{
  ticker: 'AAA',
  points: [
    { date: '2026-01-01', totalReturnPriceTwd: 100 },
    { date: '2026-02-01', totalReturnPriceTwd: 110 },
    { date: '2026-03-01', totalReturnPriceTwd: 121 },
    { date: '2026-04-01', totalReturnPriceTwd: 133.1 },
  ],
}]

describe('strategy comparison v0.1', () => {
  it('uses equal gross principal for DCA and Lump Sum', () => {
    const result = buildStrategyComparisonCore({
      request,
      priceSeries,
      transactions: [
        row({ amountForeign: 100 }),
        row({ sourceRowNumber: 3, tradeDate: '2026-03-01', quantity: -1, amountForeign: 50 }),
      ],
    })

    expect(result.dca.status).toBe('ESTIMATED')
    expect(result.lumpSum.status).toBe('ESTIMATED')
    expect(result.dca.executionCount).toBe(4)
    expect(result.dca.grossContributionsTwd).toBe(400)
    expect(result.lumpSum.grossContributionsTwd).toBe(400)
    expect(result.lumpSumPrincipalTwd).toBe(400)
    expect(result.dca.terminalValueTwd).toBeCloseTo(464.1, 8)
    expect(result.lumpSum.terminalValueTwd).toBeCloseTo(532.4, 8)
    expect(result.lumpSum.terminalValueTwd).toBeGreaterThan(result.dca.terminalValueTwd ?? 0)
  })

  it('keeps TWR independent of DCA contribution timing for a single asset', () => {
    const result = buildStrategyComparisonCore({
      request,
      priceSeries,
      transactions: [row({ amountForeign: 100 })],
    })

    expect(result.dca.cumulativeTwr).toBeCloseTo(0.331, 12)
    expect(result.lumpSum.cumulativeTwr).toBeCloseTo(0.331, 12)
    expect(result.dca.maximumDrawdown).toBe(0)
    expect(result.lumpSum.maximumDrawdown).toBe(0)
  })

  it('replays actual security buys as contributions and sells as withdrawals', () => {
    const result = buildStrategyComparisonCore({
      request,
      priceSeries,
      transactions: [
        row({ amountForeign: 100 }),
        row({ sourceRowNumber: 3, tradeDate: '2026-03-01', quantity: -1, amountForeign: 50 }),
      ],
    }).transactionReplay

    expect(result.status).toBe('ESTIMATED')
    expect(result.grossContributionsTwd).toBe(100)
    expect(result.grossWithdrawalsTwd).toBe(50)
    expect(result.terminalValueTwd).toBeCloseTo(78.1, 8)
    expect(result.estimatedGainTwd).toBeCloseTo(28.1, 8)
    expect(result.executions.map((item) => [item.executionDate, item.kind, item.amountTwd])).toEqual([
      ['2026-01-01', 'CONTRIBUTION', 100],
      ['2026-03-01', 'WITHDRAWAL', 50],
    ])
  })

  it('fails Transaction Replay closed when a foreign trade has no transaction-date FX', () => {
    const result = buildStrategyComparisonCore({
      request,
      priceSeries,
      transactions: [row({ currency: 'USD', fxRate: null })],
    })

    expect(result.dca.status).toBe('ESTIMATED')
    expect(result.lumpSum.status).toBe('ESTIMATED')
    expect(result.transactionReplay.status).toBe('INCOMPLETE')
    expect(result.transactionReplay.issues).toContainEqual(expect.objectContaining({ code: 'MISSING_REPLAY_FX' }))
  })

  it('fails replay rather than inventing leverage when a copied sale exceeds simulated wealth', () => {
    const result = buildStrategyComparisonCore({
      request,
      priceSeries,
      transactions: [
        row({ amountForeign: 100 }),
        row({ sourceRowNumber: 3, tradeDate: '2026-02-01', quantity: -1, amountForeign: 500 }),
      ],
    }).transactionReplay

    expect(result.status).toBe('INCOMPLETE')
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'REPLAY_WITHDRAWAL_EXCEEDS_VALUE' }))
    expect(result.terminalValueTwd).toBeNull()
  })

  it('moves monthly DCA dates to the next common trading day', () => {
    const shiftedRequest: StrategyComparisonRequest = {
      ...request,
      startDate: '2026-01-31',
      endDate: '2026-04-01',
    }
    const shiftedSeries = [{
      ticker: 'AAA',
      points: [
        { date: '2026-02-03', totalReturnPriceTwd: 100 },
        { date: '2026-03-03', totalReturnPriceTwd: 100 },
        { date: '2026-04-01', totalReturnPriceTwd: 100 },
      ],
    }]
    const result = buildStrategyComparisonCore({
      request: shiftedRequest,
      priceSeries: shiftedSeries,
      transactions: [row({ tradeDate: '2026-02-03' })],
    })

    expect(buildMonthlySchedule('2026-01-31', '2026-04-01')).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31',
    ])
    expect(result.dca.executions.map((item) => item.executionDate)).toEqual([
      '2026-02-03', '2026-03-03', '2026-04-01',
    ])
    expect(result.lumpSumPrincipalTwd).toBe(300)
  })

  it('supports a custom multi-asset target portfolio', () => {
    const multiRequest: StrategyComparisonRequest = {
      ...request,
      allocations: [
        { ticker: 'AAA', weight: 0.5 },
        { ticker: 'BBB', weight: 0.5 },
      ],
    }
    const multiSeries = [
      ...priceSeries,
      {
        ticker: 'BBB',
        points: [
          { date: '2026-01-01', totalReturnPriceTwd: 200 },
          { date: '2026-02-01', totalReturnPriceTwd: 200 },
          { date: '2026-03-01', totalReturnPriceTwd: 200 },
          { date: '2026-04-01', totalReturnPriceTwd: 200 },
        ],
      },
    ]
    const result = buildStrategyComparisonCore({
      request: multiRequest,
      priceSeries: multiSeries,
      transactions: [row({ amountForeign: 100 })],
    })

    expect(result.lumpSum.status).toBe('ESTIMATED')
    expect(result.lumpSum.terminalValueTwd).toBeCloseTo(466.2, 8)
  })
})
