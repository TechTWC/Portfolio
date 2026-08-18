import { describe, expect, it } from 'vitest'
import { activateMarketRun, getMarketDataBootstrap } from '../worker/market-data-repository'

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

type ActivationStatement = {
  sql: string
  bindings: unknown[]
  bind: (...values: unknown[]) => ActivationStatement
  first: () => Promise<Record<string, unknown> | null>
}

function activationDatabase(input: {
  marketRevision: number
  activeRunId: string | null
  valuationRevision: number
  activeSnapshotId: string | null
  rejectBatch?: boolean
}) {
  const batches: ActivationStatement[][] = []
  const prepare = (sql: string): ActivationStatement => {
    const statement: ActivationStatement = {
      sql,
      bindings: [],
      bind: (...values: unknown[]) => {
        statement.bindings = values
        return statement
      },
      first: async () => {
        if (sql.includes('SELECT active_dataset_id, cloud_revision FROM portfolio_state')) {
          return {
            active_dataset_id: '11111111-1111-4111-8111-111111111111',
            cloud_revision: 6,
          }
        }
        if (sql.includes('SELECT active_run_id, market_revision FROM market_state')) {
          return {
            active_run_id: input.activeRunId,
            market_revision: input.marketRevision,
          }
        }
        if (sql.includes('SELECT active_snapshot_id, valuation_revision FROM valuation_state')) {
          return {
            active_snapshot_id: input.activeSnapshotId,
            valuation_revision: input.valuationRevision,
          }
        }
        throw new Error(`Unexpected first query: ${sql}`)
      },
    }
    return statement
  }
  const db = {
    prepare,
    batch: async (statements: ActivationStatement[]) => {
      batches.push(statements)
      if (input.rejectBatch) throw new Error('D1_CONSTRAINT: activation guard proof')
      return statements.map(() => ({ success: true, meta: { changes: 1 } }))
    },
  } as unknown as D1Database
  return { db, batches }
}

const run = {
  id: 'market-run-3',
  revision: 3,
  baseRevision: 2,
  previousActiveRunId: 'market-run-2',
}
const binding = {
  transactionDatasetId: '11111111-1111-4111-8111-111111111111',
  transactionRevision: 6,
}
const valuation = {
  id: 'snapshot-v5',
  revision: 5,
  baseRevision: 4,
  previousActiveSnapshotId: 'snapshot-v4',
}

describe('atomic market-data publication', () => {
  it('publishes market data and its valuation behind one transactional version guard', async () => {
    const { db, batches } = activationDatabase({
      marketRevision: 2,
      activeRunId: 'market-run-2',
      valuationRevision: 4,
      activeSnapshotId: 'snapshot-v4',
    })

    await activateMarketRun(db, 'synthetic-user', run, binding, valuation)

    expect(batches).toHaveLength(1)
    const statements = batches[0]
    expect(statements[0].sql).toContain('INSERT INTO activation_guards')
    expect(statements[0].sql).toContain('FROM market_state market')
    expect(statements[0].sql).toContain('FROM valuation_state valuation')
    expect(statements[0].sql).toContain('FROM portfolio_state portfolio')
    expect(statements[1].sql).toContain('WHERE id IS ?')
    expect(statements[4].sql).toContain('WHERE id IS ?')
    expect(statements.at(-1)?.sql).toContain('DELETE FROM activation_guards')
  })

  it('does not repair or archive the winning run when another refresh already advanced market state', async () => {
    const { db, batches } = activationDatabase({
      marketRevision: 3,
      activeRunId: 'winning-market-run',
      valuationRevision: 4,
      activeSnapshotId: 'snapshot-v4',
      rejectBatch: true,
    })

    await expect(activateMarketRun(db, 'synthetic-user', run, binding, valuation))
      .rejects.toThrow('MARKET_DATA_VERSION_CONFLICT')
    expect(batches).toHaveLength(1)
    expect(batches[0][1].bindings).toEqual(['market-run-2', 'synthetic-user'])
  })

  it('rolls the whole publication back when valuation state advanced during the refresh', async () => {
    const { db, batches } = activationDatabase({
      marketRevision: 2,
      activeRunId: 'market-run-2',
      valuationRevision: 5,
      activeSnapshotId: 'winning-snapshot',
      rejectBatch: true,
    })

    await expect(activateMarketRun(db, 'synthetic-user', run, binding, valuation))
      .rejects.toThrow('VALUATION_VERSION_CONFLICT')
    expect(batches).toHaveLength(1)
  })
})
