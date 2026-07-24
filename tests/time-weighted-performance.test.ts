import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import {
  buildHistoricalPerformanceSeries,
  calculateTimeWeightedPerformance,
  HISTORICAL_PERFORMANCE_CALCULATION_VERSION,
  type TwrObservation,
} from '../src/lib/time-weighted-performance'

function observation(
  date: string,
  totalAssetsTwd: number,
  overrides: Partial<TwrObservation> = {},
): TwrObservation {
  return {
    date,
    complete: true,
    totalAssetsTwd,
    contributionTwd: 0,
    withdrawalTwd: 0,
    ...overrides,
  }
}

function cashTransaction(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
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
    rowHash: 'e'.repeat(64),
    ...overrides,
  }
}

describe('time-weighted performance and drawdown', () => {
  it('chains returns geometrically rather than adding percentages', () => {
    const result = calculateTimeWeightedPerformance([
      observation('2026-01-01', 100),
      observation('2026-01-02', 110),
      observation('2026-01-03', 99),
    ])

    expect(result.complete).toBe(true)
    expect(result.points[1].periodReturn).toBeCloseTo(0.1, 12)
    expect(result.points[2].periodReturn).toBeCloseTo(-0.1, 12)
    expect(result.cumulativeTwr).toBeCloseTo(-0.01, 12)
    expect(result.drawdown.maximumDrawdown).toBeCloseTo(-0.1, 12)
    expect(result.drawdown.peakDate).toBe('2026-01-02')
    expect(result.drawdown.troughDate).toBe('2026-01-03')
    expect(result.drawdown.currentDrawdown).toBeCloseTo(-0.1, 12)
    expect(result.drawdown.currentlyInDrawdown).toBe(true)
  })

  it('neutralizes a contribution as start-of-day external capital', () => {
    const result = calculateTimeWeightedPerformance([
      observation('2026-01-01', 100),
      observation('2026-02-01', 150, { contributionTwd: 50 }),
      observation('2026-03-01', 165),
    ])

    expect(result.points[1].periodReturn).toBe(0)
    expect(result.points[2].periodReturn).toBeCloseTo(0.1, 12)
    expect(result.cumulativeTwr).toBeCloseTo(0.1, 12)
  })

  it('neutralizes a withdrawal as end-of-day returned capital', () => {
    const result = calculateTimeWeightedPerformance([
      observation('2026-01-01', 100),
      observation('2026-02-01', 50, { withdrawalTwd: 50 }),
    ])

    expect(result.complete).toBe(true)
    expect(result.points[1].periodReturn).toBe(0)
    expect(result.cumulativeTwr).toBe(0)
  })

  it('records maximum drawdown recovery and current recovery status separately', () => {
    const result = calculateTimeWeightedPerformance([
      observation('2026-01-01', 100),
      observation('2026-01-02', 80),
      observation('2026-01-03', 110),
    ])

    expect(result.drawdown.maximumDrawdown).toBeCloseTo(-0.2, 12)
    expect(result.drawdown.peakDate).toBe('2026-01-01')
    expect(result.drawdown.troughDate).toBe('2026-01-02')
    expect(result.drawdown.recoveryDate).toBe('2026-01-03')
    expect(result.drawdown.declineDays).toBe(1)
    expect(result.drawdown.recoveryDays).toBe(1)
    expect(result.drawdown.underwaterDays).toBe(2)
    expect(result.drawdown.currentDrawdown).toBe(0)
    expect(result.drawdown.currentlyInDrawdown).toBe(false)
  })

  it('distinguishes historical maximum drawdown from current drawdown', () => {
    const result = calculateTimeWeightedPerformance([
      observation('2026-01-01', 100),
      observation('2026-01-02', 120),
      observation('2026-01-03', 90),
      observation('2026-01-04', 108),
      observation('2026-01-05', 102),
    ])

    expect(result.drawdown.maximumDrawdown).toBeCloseTo(-0.25, 12)
    expect(result.drawdown.peakDate).toBe('2026-01-02')
    expect(result.drawdown.troughDate).toBe('2026-01-03')
    expect(result.drawdown.recoveryDate).toBeNull()
    expect(result.drawdown.currentDrawdown).toBeCloseTo(-0.15, 12)
    expect(result.drawdown.currentlyInDrawdown).toBe(true)
    expect(result.drawdown.currentPeakDate).toBe('2026-01-02')
    expect(result.drawdown.currentUnderwaterDays).toBe(3)
  })

  it('annualizes a one-year 10 percent TWR to 10 percent', () => {
    const result = calculateTimeWeightedPerformance([
      observation('2026-01-01', 100),
      observation('2027-01-01', 110),
    ])

    expect(result.dayCount).toBe(365)
    expect(result.cumulativeTwr).toBeCloseTo(0.1, 12)
    expect(result.annualizedTwr).toBeCloseTo(0.1, 12)
  })

  it('reports a complete loss as minus 100 percent for TWR, annualized TWR, and drawdown', () => {
    const result = calculateTimeWeightedPerformance([
      observation('2026-01-01', 100),
      observation('2026-07-01', 0),
    ])

    expect(result.complete).toBe(true)
    expect(result.cumulativeTwr).toBe(-1)
    expect(result.annualizedTwr).toBe(-1)
    expect(result.drawdown.maximumDrawdown).toBe(-1)
  })

  it('automatically inserts every external cash-flow date into the NAV series', () => {
    const transactions = [
      cashTransaction({ sourceRowNumber: 2, tradeDate: '2026-01-01', amountForeign: 10_000 }),
      cashTransaction({ sourceRowNumber: 3, tradeDate: '2026-02-01', amountForeign: 1_000 }),
    ]
    const result = buildHistoricalPerformanceSeries({
      transactions,
      marks: [],
      dates: ['2026-01-01', '2026-03-01'],
      transactionRevision: 6,
      valuationRevision: 4,
      valuationSnapshotId: 'snapshot-v4',
      valuationDate: '2026-03-01',
    })

    expect(result.observationDates).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
    expect(result.performance.complete).toBe(true)
    expect(result.performance.cumulativeTwr).toBe(0)
    expect(result.performance.points[1]).toMatchObject({
      date: '2026-02-01',
      contributionTwd: 1_000,
      totalAssetsTwd: 11_000,
      periodReturn: 0,
    })
  })

  it('carries transaction, valuation, snapshot, date, and calculation versions', () => {
    const result = buildHistoricalPerformanceSeries({
      transactions: [
        cashTransaction({ tradeDate: '2026-01-01', amountForeign: 10_000 }),
      ],
      marks: [],
      dates: ['2026-01-01', '2026-03-01'],
      transactionRevision: 6,
      valuationRevision: 4,
      valuationSnapshotId: 'snapshot-v4',
      valuationDate: '2026-03-01',
    })

    expect(result.provenance).toEqual({
      transactionRevision: 6,
      valuationRevision: 4,
      valuationSnapshotId: 'snapshot-v4',
      valuationDate: '2026-03-01',
      calculationVersion: HISTORICAL_PERFORMANCE_CALCULATION_VERSION,
    })
  })

  it('blocks the whole chain when any required NAV point is incomplete', () => {
    const result = calculateTimeWeightedPerformance([
      observation('2026-01-01', 100),
      observation('2026-02-01', 110, { complete: false, totalAssetsTwd: null }),
      observation('2026-03-01', 120),
    ])

    expect(result.complete).toBe(false)
    expect(result.cumulativeTwr).toBeNull()
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'INCOMPLETE_NAV_POINT',
      dates: ['2026-02-01'],
    }))
  })

  it('requires at least two NAV observations', () => {
    const result = calculateTimeWeightedPerformance([
      observation('2026-01-01', 100),
    ])

    expect(result.complete).toBe(false)
    expect(result.issues.some((issue) => issue.code === 'INSUFFICIENT_OBSERVATIONS')).toBe(true)
  })
})
