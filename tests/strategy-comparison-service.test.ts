import { describe, expect, it, vi } from 'vitest'
import { strategyComparisonRequestSchema } from '../src/lib/strategy-comparison-contracts'
import { runStrategyComparison } from '../worker/strategy-comparison-service'

const request = {
  startDate: '2026-01-01',
  endDate: '2026-04-01',
  dcaMonthlyAmountTwd: 70000,
  allocations: [{ ticker: '0050.TW', weight: 1 }],
}

function fixtureDatabase(conflict = false) {
  const state = vi.fn()
    .mockResolvedValueOnce({ active_dataset_id: 'ds1', cloud_revision: 1 })
    .mockResolvedValue({ active_dataset_id: conflict ? 'ds2' : 'ds1', cloud_revision: conflict ? 2 : 1 })
  const calls: { sql: string; bind: unknown[] }[] = []
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          calls.push({ sql, bind: args })
          if (sql.includes('FROM portfolio_state')) return state()
          throw new Error('Unexpected SQL in synthetic test')
        },
        all: async () => {
          calls.push({ sql, bind: args })
          if (sql.includes('FROM transactions')) return {
            results: [{
              transaction_id: 'trade1', source_row_number: 1, trade_date: '2026-01-02',
              transaction_type: 'SECURITY', ticker: '0050.TW', currency: 'TWD',
              quantity: 1, price: 100, amount_foreign: 100,
              fx_rate: 1, fee: 0, budget_waterline: null, budget_balance: null,
              note: '', row_hash: 'synthetic-only',
            }],
          }
          throw new Error('Unexpected SQL in synthetic test')
        },
      }),
    }),
  }
  return { db: db as unknown as D1Database, calls }
}

function fixtureFetcher() {
  const dates = ['2026-01-02', '2026-02-02', '2026-03-02', '2026-04-01']
  return vi.fn(async () => new Response(JSON.stringify({
    chart: {
      result: [{
        meta: { currency: 'TWD', exchangeTimezoneName: 'Asia/Taipei' },
        timestamp: dates.map((date) => Math.floor(Date.parse(date + 'T05:30:00Z') / 1000)),
        indicators: {
          quote: [{ close: [100, 110, 121, 133.1] }],
          adjclose: [{ adjclose: [100, 110, 121, 133.1] }],
        },
      }],
    },
  }), { status: 200 }))
}

describe('Strategy Comparison input integrity / read-only service', () => {
  it('rejects impossible calendar dates, unsupported tickers and excessive windows', () => {
    for (const patch of [
      { startDate: '2026-02-30' },
      { endDate: '2026-13-01' },
      { startDate: '1990-01-01' },
      { allocations: [{ ticker: 'AAPL?inject=1', weight: 1 }] },
      { allocations: [{ ticker: '0050.TW', weight: 0.9 }] },
    ]) {
      expect(strategyComparisonRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false)
    }
    expect(strategyComparisonRequestSchema.safeParse(request).success).toBe(true)
  })

  it('reuses the same transaction Dataset and checks current revision after the calculation', async () => {
    const { db, calls } = fixtureDatabase()
    const result = await runStrategyComparison(
      db, { id: 'synthetic-user', email: 'not-real@example.test' },
      request, { now: new Date('2026-04-02T00:00:00Z'), fetcher: fixtureFetcher() as typeof fetch },
    )
    expect(result.transactionRevision).toBe(1)
    expect(result.strategies.dca.grossContributionsTwd).toBe(280000)
    expect(result.strategies.lumpSum.grossContributionsTwd).toBe(280000)
    const transactionsQuery = calls.filter((c) => c.sql.includes('FROM transactions'))
    expect(transactionsQuery).toHaveLength(1)
    expect(transactionsQuery[0].bind).toEqual(['ds1', 'synthetic-user'])
  })

  it('fails closed if the ACTIVE transaction version changes while Yahoo data is fetched', async () => {
    const { db } = fixtureDatabase(true)
    await expect(runStrategyComparison(
      db, { id: 'synthetic-user', email: 'not-real@example.test' },
      request, { now: new Date('2026-04-02T00:00:00Z'), fetcher: fixtureFetcher() as typeof fetch },
    )).rejects.toThrow('TRANSACTION_VERSION_CONFLICT')
  })
})
