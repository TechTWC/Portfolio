import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import { buildAsOfNavPoint, buildHistoricalNavSeries } from '../src/lib/historical-nav'
import type { ValuationMark } from '../src/lib/valuation'

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
    rowHash: 'd'.repeat(64),
    ...overrides,
  }
}

function mark(overrides: Partial<ValuationMark>): ValuationMark {
  return {
    sourceRowNumber: 2,
    markDate: '2026-01-02',
    markType: 'PRICE',
    ticker: 'AAA',
    currency: 'TWD',
    value: 50,
    source: 'SYNTHETIC',
    ...overrides,
  }
}

const transactions: NormalizedTransaction[] = [
  transaction({ sourceRowNumber: 2, tradeDate: '2026-01-01', amountForeign: 10_000 }),
  transaction({
    sourceRowNumber: 3,
    tradeDate: '2026-01-02',
    transactionType: 'SECURITY',
    ticker: 'AAA',
    quantity: 10,
    price: 50,
    amountForeign: 500,
  }),
  transaction({
    sourceRowNumber: 4,
    tradeDate: '2026-02-01',
    transactionType: 'SECURITY',
    ticker: 'BBB',
    currency: 'USD',
    quantity: 2,
    price: 100,
    amountForeign: 200,
    fxRate: 32,
  }),
  transaction({
    sourceRowNumber: 5,
    tradeDate: '2026-03-01',
    transactionType: 'SECURITY',
    ticker: 'AAA',
    quantity: -5,
    price: 60,
    amountForeign: 300,
  }),
]

const marks: ValuationMark[] = [
  mark({ sourceRowNumber: 2, markDate: '2026-01-02', ticker: 'AAA', currency: 'TWD', value: 50 }),
  mark({ sourceRowNumber: 3, markDate: '2026-02-01', ticker: 'AAA', currency: 'TWD', value: 55 }),
  mark({ sourceRowNumber: 4, markDate: '2026-03-01', ticker: 'AAA', currency: 'TWD', value: 60 }),
  mark({ sourceRowNumber: 5, markDate: '2026-02-01', ticker: 'BBB', currency: 'USD', value: 100 }),
  mark({ sourceRowNumber: 6, markDate: '2026-03-01', ticker: 'BBB', currency: 'USD', value: 110 }),
  mark({ sourceRowNumber: 7, markDate: '2026-02-01', markType: 'FX', ticker: '', currency: 'USD', value: 32 }),
  mark({ sourceRowNumber: 8, markDate: '2026-03-01', markType: 'FX', ticker: '', currency: 'USD', value: 33 }),
]

describe('historical as-of NAV reconstruction', () => {
  it('rebuilds three Point-in-Time NAV points without future leakage', () => {
    const series = buildHistoricalNavSeries({
      transactions,
      marks,
      dates: ['2026-03-15', '2026-01-15', '2026-02-15'],
    })

    expect(series.normalizedDates).toEqual(['2026-01-15', '2026-02-15', '2026-03-15'])
    expect(series.completePointCount).toBe(3)
    expect(series.incompletePointCount).toBe(0)

    expect(series.points.map((point) => ({
      date: point.asOfDate,
      transactions: point.transactionCount,
      position: point.positionValueTwd,
      cash: point.cashValueTwd,
      total: point.totalAssetsTwd,
    }))).toEqual([
      { date: '2026-01-15', transactions: 2, position: 500, cash: 9_500, total: 10_000 },
      { date: '2026-02-15', transactions: 3, position: 6_950, cash: 3_100, total: 10_050 },
      { date: '2026-03-15', transactions: 4, position: 7_560, cash: 3_400, total: 10_960 },
    ])
  })

  it('does not include a buy after the as-of date', () => {
    const point = buildAsOfNavPoint(transactions, marks, '2026-01-15')

    expect(point.valuation.positions.map((position) => position.ticker)).toEqual(['AAA'])
    expect(point.transactionCount).toBe(2)
  })

  it('does not apply a later sell to an earlier holding', () => {
    const point = buildAsOfNavPoint(transactions, marks, '2026-02-15')
    const aaa = point.valuation.positions.find((position) => position.ticker === 'AAA')

    expect(aaa?.quantity).toBe(10)
  })

  it('selects only price and FX marks on or before the point date', () => {
    const point = buildAsOfNavPoint(transactions, marks, '2026-02-15')
    const aaa = point.valuation.positions.find((position) => position.ticker === 'AAA')
    const bbb = point.valuation.positions.find((position) => position.ticker === 'BBB')

    expect(aaa).toMatchObject({ price: 55, priceDate: '2026-02-01' })
    expect(bbb).toMatchObject({ price: 100, priceDate: '2026-02-01', fxRate: 32, fxDate: '2026-02-01' })
    expect(point.valuation.futureMarkCount).toBe(3)
  })

  it('does not require a price for a position closed by the as-of date', () => {
    const closedTransactions = [
      transaction({ sourceRowNumber: 2, amountForeign: 1_000 }),
      transaction({
        sourceRowNumber: 3,
        tradeDate: '2026-01-02',
        transactionType: 'SECURITY',
        ticker: 'CLOSED',
        quantity: 1,
        price: 100,
        amountForeign: 100,
      }),
      transaction({
        sourceRowNumber: 4,
        tradeDate: '2026-01-03',
        transactionType: 'SECURITY',
        ticker: 'CLOSED',
        quantity: -1,
        price: 110,
        amountForeign: 110,
      }),
    ]

    const point = buildAsOfNavPoint(closedTransactions, [], '2026-01-04')
    expect(point.complete).toBe(true)
    expect(point.valuation.positions).toEqual([])
    expect(point.totalAssetsTwd).toBe(1_010)
  })

  it('marks only a point missing its required price as incomplete', () => {
    const incompleteMarks = marks.filter((item) => !(item.ticker === 'BBB' && item.markType === 'PRICE'))
    const series = buildHistoricalNavSeries({
      transactions,
      marks: incompleteMarks,
      dates: ['2026-01-15', '2026-02-15'],
    })

    expect(series.points[0].complete).toBe(true)
    expect(series.points[1].complete).toBe(false)
    expect(series.points[1].issues.some((issue) => issue.code === 'MISSING_PRICE')).toBe(true)
  })

  it('deduplicates and sorts valid dates while reporting invalid dates', () => {
    const series = buildHistoricalNavSeries({
      transactions,
      marks,
      dates: ['2026-02-15', 'invalid', '2026-01-15', '2026-02-15'],
    })

    expect(series.normalizedDates).toEqual(['2026-01-15', '2026-02-15'])
    expect(series.points).toHaveLength(2)
    expect(series.issues).toContainEqual(expect.objectContaining({ code: 'INVALID_AS_OF_DATE' }))
  })

  it('reports external contributions separately from NAV', () => {
    const point = buildAsOfNavPoint(transactions, marks, '2026-01-01')

    expect(point.contributionTwdOnDate).toBe(10_000)
    expect(point.withdrawalTwdOnDate).toBe(0)
    expect(point.totalAssetsTwd).toBe(10_000)
  })

  it('is deterministic regardless of transaction and mark input order', () => {
    const dates = ['2026-03-15', '2026-01-15']
    const direct = buildHistoricalNavSeries({ transactions, marks, dates })
    const reversed = buildHistoricalNavSeries({
      transactions: [...transactions].reverse(),
      marks: [...marks].reverse(),
      dates,
    })

    expect(reversed).toEqual(direct)
  })
})
