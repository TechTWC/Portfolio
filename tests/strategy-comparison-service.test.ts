import { afterEach, describe, expect, it, vi } from 'vitest'
import { strategyComparisonRequestSchema } from '../src/lib/strategy-comparison-contracts'
import { PortfolioReadSession } from '../worker/ai/read-session'
import { adjustedStrategyPriceTwd, runStrategyComparison } from '../worker/strategy-comparison-service'

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

function fixtureFetcher(adjustedClose: Array<number | null> = [100, 110, 121, 133.1]) {
  const dates = ['2026-01-02', '2026-02-02', '2026-03-02', '2026-04-01']
  return vi.fn(async () => new Response(JSON.stringify({
    chart: {
      result: [{
        meta: { currency: 'TWD', exchangeTimezoneName: 'Asia/Taipei' },
        timestamp: dates.map((date) => Math.floor(Date.parse(date + 'T05:30:00Z') / 1000)),
        indicators: {
          quote: [{ close: [100, 110, 121, 133.1] }],
          adjclose: [{ adjclose: adjustedClose }],
        },
      }],
    },
  }), { status: 200 }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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
    expect(result.marketDataVersion).toMatch(/^YAHOO_FINANCE_CHART_ADJUSTED_CLOSE_PROXY:v0\.1:[0-9a-f]{64}$/)
    const transactionsQuery = calls.filter((c) => c.sql.includes('FROM transactions'))
    expect(transactionsQuery).toHaveLength(1)
    expect(transactionsQuery[0].bind).toEqual(['ds1', 'synthetic-user'])
  })

  it('rejects incomplete adjusted-close history instead of shifting DCA dates unnoticed', async () => {
    const { db } = fixtureDatabase()
    await expect(runStrategyComparison(
      db, { id: 'synthetic-user', email: 'not-real@example.test' },
      request, {
        now: new Date('2026-04-02T00:00:00Z'),
        fetcher: fixtureFetcher([100, null, 121, 133.1]) as typeof fetch,
      },
    )).rejects.toThrow('MISSING_STRATEGY_ADJUSTED_CLOSE')
  })

  it('scales GBp prices to whole GBP before applying the TWD historical FX rate', () => {
    expect(adjustedStrategyPriceTwd(120, 0.01, 40)).toBeCloseTo(48, 10)
    expect(adjustedStrategyPriceTwd(120, 1, 40)).toBeCloseTo(4800, 10)
    expect(() => adjustedStrategyPriceTwd(120, 0, 40)).toThrow('INVALID_STRATEGY_TWD_PRICE')
  })

  it('rejects incomplete start coverage even if end prices are available', async () => {
    const { db } = fixtureDatabase()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      chart: { result: [{
        meta: { currency: 'TWD', exchangeTimezoneName: 'Asia/Taipei' },
        timestamp: ['2026-03-01', '2026-04-01']
          .map((date) => Math.floor(Date.parse(date + 'T05:30:00Z') / 1000)),
        indicators: {
          quote: [{ close: [100, 110] }],
          adjclose: [{ adjclose: [100, 110] }],
        },
      }] },
    }), { status: 200 }))
    await expect(runStrategyComparison(
      db, { id: 'synthetic-user', email: 'not-real@example.test' },
      request, { now: new Date('2026-10-08T00:00:00Z'), fetcher: fetcher as typeof fetch },
    )).rejects.toThrow('TRUNCATED_STRATEGY_HISTORY')
  })

  it('rejects insufficient shared-market coverage across individually valid series', async () => {
    const { db } = fixtureDatabase()
    const fetcher = vi.fn(async (url: string) => {
      const dates = url.includes('/BBB?')
        ? ['2026-01-03', '2026-02-03', '2026-03-03', '2026-04-01']
        : ['2026-01-02', '2026-02-02', '2026-03-02', '2026-04-01']
      return new Response(JSON.stringify({
        chart: { result: [{
          meta: { currency: 'TWD', exchangeTimezoneName: 'Asia/Taipei' },
          timestamp: dates.map((date) => Math.floor(Date.parse(date + 'T05:30:00Z') / 1000)),
          indicators: {
            quote: [{ close: [100, 110, 120, 130] }],
            adjclose: [{ adjclose: [100, 110, 120, 130] }],
          },
        }] },
      }), { status: 200 })
    })
    await expect(runStrategyComparison(
      db, { id: 'synthetic-user', email: 'not-real@example.test' },
      { ...request, allocations: [{ ticker: 'AAA', weight: 0.5 }, { ticker: 'BBB', weight: 0.5 }] },
      { now: new Date('2026-10-08T00:00:00Z'), fetcher: fetcher as typeof fetch },
    )).rejects.toThrow('TRUNCATED_COMMON_STRATEGY_HISTORY')
  })

  it('fails closed if the ACTIVE transaction version changes while Yahoo data is fetched', async () => {
    const { db } = fixtureDatabase(true)
    await expect(runStrategyComparison(
      db, { id: 'synthetic-user', email: 'not-real@example.test' },
      request, { now: new Date('2026-04-02T00:00:00Z'), fetcher: fixtureFetcher() as typeof fetch },
    )).rejects.toThrow('TRANSACTION_VERSION_CONFLICT')
  })

  it('applies the shared per-user admission limit before database or Yahoo work', async () => {
    const { db, calls } = fixtureDatabase()
    const fetcher = fixtureFetcher()
    const rateLimiter = {
      limit: vi.fn(async () => ({ success: false })),
    } as unknown as RateLimit

    await expect(runStrategyComparison(
      db,
      { id: 'rate-limited-user', email: 'not-real@example.test' },
      request,
      { now: new Date('2026-04-02T00:00:00Z'), fetcher: fetcher as typeof fetch, rateLimiter },
    )).rejects.toThrow('STRATEGY_RATE_LIMITED')

    expect(rateLimiter.limit).toHaveBeenCalledWith({
      key: 'strategy-comparison:rate-limited-user',
    })
    expect(calls).toHaveLength(0)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reuses one completed Yahoo snapshot for MCP query and lineage sessions', async () => {
    const { db } = fixtureDatabase()
    const fetcher = fixtureFetcher()
    vi.stubGlobal('fetch', fetcher)
    const user = { id: 'mcp-cache-regression-user', email: 'not-real@example.test' }
    const first = new PortfolioReadSession(db, user, new Date('2026-04-02T00:00:00Z'))
    const second = new PortfolioReadSession(db, user, new Date('2026-04-02T00:00:30Z'))

    const queryResult = await first.strategyComparison(request)
    const lineageResult = await second.cachedStrategyComparison(request)

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(lineageResult).toBe(queryResult)
    expect(lineageResult.marketDataVersion).toBe(queryResult.marketDataVersion)
  })
})
