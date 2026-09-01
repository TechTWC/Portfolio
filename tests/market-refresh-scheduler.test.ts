import { describe, expect, it, vi } from 'vitest'
import type { MarketDataRefreshResponse } from '../src/lib/market-data-contracts'
import { runScheduledMarketRefresh } from '../worker/market-refresh-scheduler'

type Recorded = { sql: string; bindings: unknown[] }

function schedulerDatabase(reservationChanges = 1, activeDataset = true) {
  const writes: Recorded[] = []
  const prepare = (sql: string) => {
    const statement = {
      bindings: [] as unknown[],
      bind: (...values: unknown[]) => {
        statement.bindings = values
        return statement
      },
      all: async () => {
        if (sql.includes('FROM users')) return { results: [{ id: 'user-1', email: 'owner@example.test' }] }
        throw new Error(`Unexpected all query: ${sql}`)
      },
      first: async () => {
        if (sql.includes('FROM portfolio_state')) {
          return {
            active_dataset_id: activeDataset ? '11111111-1111-4111-8111-111111111111' : null,
            cloud_revision: activeDataset ? 8 : 0,
          }
        }
        if (sql.includes('FROM market_state')) return { active_run_id: 'market-3', market_revision: 3 }
        if (sql.includes('FROM valuation_state')) return { valuation_revision: 7 }
        throw new Error(`Unexpected first query: ${sql}`)
      },
      run: async () => {
        writes.push({ sql, bindings: [...statement.bindings] })
        return { success: true, meta: { changes: sql.includes('INSERT OR IGNORE') ? reservationChanges : 1 } }
      },
    }
    return statement
  }
  return { db: { prepare } as unknown as D1Database, writes }
}

function successfulResponse(): MarketDataRefreshResponse {
  return {
    market: {
      marketRevision: 4,
      currentTransactionDatasetId: '11111111-1111-4111-8111-111111111111',
      currentTransactionRevision: 8,
      freshness: 'CURRENT', freshnessReason: 'CURRENT', latestBarAgeDays: 0, staleAfterDays: 4,
      activeRun: { latestBarDate: '2026-09-01' } as MarketDataRefreshResponse['market']['activeRun'],
      instruments: [], marks: [], lastScheduledRefresh: null,
    },
    valuation: { valuationRevision: 8 } as MarketDataRefreshResponse['valuation'],
  }
}

describe('Cloudflare scheduled market refresh', () => {
  it('uses the active transaction and valuation versions and records success', async () => {
    const fixture = schedulerDatabase()
    const refresh = vi.fn().mockResolvedValue(successfulResponse())
    await runScheduledMarketRefresh(fixture.db, Date.parse('2026-09-01T23:30:00Z'), {
      now: new Date('2026-09-01T23:30:00Z'),
      refresh: refresh as never,
    })

    expect(refresh).toHaveBeenCalledWith(
      fixture.db,
      { id: 'user-1', email: 'owner@example.test' },
      {
        baseValuationRevision: 7,
        transactionDatasetId: '11111111-1111-4111-8111-111111111111',
        transactionRevision: 8,
      },
      { now: new Date('2026-09-01T23:30:00Z') },
    )
    const completion = fixture.writes.find((write) => write.sql.includes('UPDATE market_refresh_jobs'))
    expect(completion?.bindings).toEqual(expect.arrayContaining(['SUCCEEDED', 1, 4, 8, '2026-09-01']))
  })

  it('retries one transient upstream failure and records the attempt count', async () => {
    const fixture = schedulerDatabase()
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error('SPY 行情來源回應 HTTP 503'))
      .mockResolvedValueOnce(successfulResponse())
    await runScheduledMarketRefresh(fixture.db, Date.parse('2026-09-01T23:30:00Z'), {
      refresh: refresh as never,
    })

    expect(refresh).toHaveBeenCalledTimes(2)
    const completion = fixture.writes.find((write) => write.sql.includes('UPDATE market_refresh_jobs'))
    expect(completion?.bindings).toContain(2)
  })

  it('records a terminal upstream failure without replacing ACTIVE data', async () => {
    const fixture = schedulerDatabase()
    const refresh = vi.fn().mockRejectedValue(new Error('SPY 行情來源回應 HTTP 503'))
    await runScheduledMarketRefresh(fixture.db, Date.parse('2026-09-01T23:30:00Z'), {
      refresh: refresh as never,
    })

    expect(refresh).toHaveBeenCalledTimes(2)
    const completion = fixture.writes.find((write) => write.sql.includes('UPDATE market_refresh_jobs'))
    expect(completion?.bindings).toEqual(expect.arrayContaining([
      'FAILED', 2, 'UPSTREAM_HTTP_503', 'SPY 行情來源回應 HTTP 503',
    ]))
  })

  it('does not execute the same scheduled event twice', async () => {
    const fixture = schedulerDatabase(0)
    const refresh = vi.fn()
    await runScheduledMarketRefresh(fixture.db, Date.parse('2026-09-01T23:30:00Z'), {
      refresh: refresh as never,
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('records why a user without an ACTIVE dataset was not updated', async () => {
    const fixture = schedulerDatabase(1, false)
    const refresh = vi.fn()
    await runScheduledMarketRefresh(fixture.db, Date.parse('2026-09-01T23:30:00Z'), {
      refresh: refresh as never,
    })
    expect(refresh).not.toHaveBeenCalled()
    const completion = fixture.writes.find((write) => write.sql.includes('UPDATE market_refresh_jobs'))
    expect(completion?.bindings).toEqual(expect.arrayContaining([
      'SKIPPED', 0, 'NO_ACTIVE_DATASET', '目前沒有 ACTIVE 交易資料，排程未更新行情',
    ]))
  })
})
