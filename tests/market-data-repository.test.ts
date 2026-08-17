import { describe, expect, it } from 'vitest'
import { getMarketDataBootstrap } from '../worker/market-data-repository'

function marketDatabase(): D1Database {
  const prepare = (sql: string) => {
    let bindings: unknown[] = []
    const statement = {
      bind: (...values: unknown[]) => {
        bindings = values
        return statement
      },
      first: async () => {
        if (sql.includes('FROM portfolio_state')) {
          return { active_dataset_id: '11111111-1111-4111-8111-111111111111', cloud_revision: 6 }
        }
        if (sql.includes('FROM market_state')) {
          return { active_run_id: 'market-run-2', market_revision: 2 }
        }
        if (sql.includes('FROM market_data_runs WHERE id')) {
          return {
            id: 'market-run-2',
            revision: 2,
            status: 'ACTIVE',
            provider: 'YAHOO_FINANCE_CHART',
            data_version: 'market-data-v1.0.0',
            benchmark_ticker: 'SPY',
            transaction_dataset_id: '11111111-1111-4111-8111-111111111111',
            transaction_revision: 6,
            instrument_count: 1,
            bar_count: 1,
            earliest_bar_date: '2026-01-03',
            latest_bar_date: '2026-01-03',
            fetched_at: '2026-01-04T00:00:00.000Z',
            activated_at: '2026-01-04 00:00:01',
          }
        }
        throw new Error(`Unexpected first query: ${sql}`)
      },
      all: async () => {
        if (sql.includes('bar_count, earliest_bar_date')) {
          return {
            results: [{
              instrument_type: 'SECURITY',
              ticker: 'VOO',
              currency: 'USD',
              provider_symbol: 'VOO',
              exchange_timezone: 'America/New_York',
              bar_count: 1,
              earliest_bar_date: '2026-01-03',
              latest_bar_date: '2026-01-03',
              latest_raw_close: 110,
            }],
          }
        }
        if (sql.includes('instrument.bars_json')) {
          expect(bindings).toEqual(['synthetic-user', 2])
          return {
            results: [
              {
                instrument_type: 'SECURITY', ticker: 'VOO', currency: 'USD',
                bars_json: JSON.stringify([
                  { date: '2026-01-02', rawClose: 100, adjustedClose: 99, rowHash: 'a'.repeat(64) },
                  { date: '2026-01-03', rawClose: 105, adjustedClose: 104, rowHash: 'b'.repeat(64) },
                ]),
              },
              {
                instrument_type: 'SECURITY', ticker: 'VOO', currency: 'USD',
                bars_json: JSON.stringify([
                  { date: '2026-01-03', rawClose: 110, adjustedClose: 109, rowHash: 'c'.repeat(64) },
                ]),
              },
            ],
          }
        }
        throw new Error(`Unexpected all query: ${sql}`)
      },
    }
    return statement
  }
  return { prepare } as unknown as D1Database
}

describe('ACTIVE market-data series reconstruction', () => {
  it('merges incremental segments and lets the latest active revision correct an overlap', async () => {
    const result = await getMarketDataBootstrap(
      marketDatabase(),
      { id: 'synthetic-user', email: 'synthetic@example.test' },
    )

    expect(result.freshness).toBe('CURRENT')
    expect(result.marketRevision).toBe(2)
    expect(result.marks).toEqual([
      expect.objectContaining({ markDate: '2026-01-02', ticker: 'VOO', value: 100 }),
      expect.objectContaining({ markDate: '2026-01-03', ticker: 'VOO', value: 110 }),
    ])
  })

  it('can return summary metadata without loading the historical series', async () => {
    const result = await getMarketDataBootstrap(
      marketDatabase(),
      { id: 'synthetic-user', email: 'synthetic@example.test' },
      false,
    )
    expect(result.instruments).toHaveLength(1)
    expect(result.marks).toEqual([])
  })
})
