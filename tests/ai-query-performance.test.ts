import { describe, expect, it } from 'vitest'
import type { StoredTransaction } from '../src/lib/contracts'
import { createDataRegistry, createMetricRegistry } from '../worker/ai/platform'
import { PortfolioReadSession } from '../worker/ai/read-session'

const PRODUCTION_TRANSACTION_COUNT = 127
const PRODUCTION_SYMBOL_COUNT = 13
const QUERY_TIMEOUT_MS = 500

function dateFor(index: number): string {
  const date = new Date(Date.UTC(2021, 0, 1 + index))
  return date.toISOString().slice(0, 10)
}

function productionTransactions(): StoredTransaction[] {
  return Array.from({ length: PRODUCTION_TRANSACTION_COUNT }, (_, index) => ({
    transactionId: `transaction-${index + 1}`,
    sourceRowNumber: index + 2,
    tradeDate: dateFor(index),
    transactionType: 'SECURITY' as const,
    ticker: `TICKER-${(index % PRODUCTION_SYMBOL_COUNT) + 1}`,
    currency: 'TWD',
    quantity: 1,
    price: 100 + index,
    amountForeign: 100 + index,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: index.toString(16).padStart(64, '0'),
  }))
}

function productionDatabase() {
  const transactions = productionTransactions()
  const executedSql: string[] = []
  let historicalSeriesReads = 0

  const prepare = (sql: string) => ({
    bind: (..._values: unknown[]) => ({
      first: async () => {
        executedSql.push(sql)
        if (sql.includes('FROM portfolio_state')) {
          return {
            active_dataset_id: 'dataset-1', cloud_revision: 1,
            filename: 'Portfolio_Analyzer_交易匯入_127筆.xlsx', parser_version: 'parser-v0.8',
            earliest_date: '2021-01-01', latest_date: '2026-08-17',
            activated_at: '2026-08-17 09:38:00',
          }
        }
        if (sql.includes('FROM valuation_state')) {
          return { active_snapshot_id: 'snapshot-1', valuation_revision: 1 }
        }
        if (sql.includes('FROM valuation_snapshots')) {
          return {
            id: 'snapshot-1', revision: 1, valuation_date: '2026-08-17',
            parser_version: 'valuation-v0.3', transaction_dataset_id: 'dataset-1',
            transaction_revision: 1, activated_at: '2026-08-17 09:40:00',
          }
        }
        if (sql.includes('FROM market_state')) {
          return { active_run_id: 'market-1', market_revision: 1 }
        }
        if (sql.includes('FROM market_data_runs')) {
          return {
            id: 'market-1', revision: 1, provider: 'YAHOO_FINANCE_CHART',
            data_version: 'market-data-v1.0.0', transaction_dataset_id: 'dataset-1',
            transaction_revision: 1, earliest_bar_date: '2021-01-01',
            latest_bar_date: '2026-08-17', fetched_at: '2026-08-17 09:39:00',
            activated_at: '2026-08-17 09:39:30',
          }
        }
        throw new Error(`Unexpected first() SQL: ${sql}`)
      },
      all: async () => {
        executedSql.push(sql)
        if (sql.includes('FROM transactions')) {
          return {
            results: transactions.map((row) => ({
              transaction_id: row.transactionId,
              source_row_number: row.sourceRowNumber,
              trade_date: row.tradeDate,
              transaction_type: row.transactionType,
              ticker: row.ticker,
              currency: row.currency,
              quantity: row.quantity,
              price: row.price,
              amount_foreign: row.amountForeign,
              fx_rate: row.fxRate,
              fee: row.fee,
              budget_waterline: row.budgetWaterline,
              budget_balance: row.budgetBalance,
              note: row.note,
              row_hash: row.rowHash,
            })),
          }
        }
        if (sql.includes('FROM valuation_marks')) {
          return {
            results: Array.from({ length: PRODUCTION_SYMBOL_COUNT }, (_, index) => ({
              source_row_number: index + 1,
              mark_date: '2026-08-17',
              mark_type: 'PRICE',
              ticker: `TICKER-${index + 1}`,
              currency: 'TWD',
              value: 300 + index,
              source: 'TEST:CURRENT',
              row_hash: (index + 1).toString(16).padStart(64, '0'),
            })),
          }
        }
        if (sql.includes('FROM market_data_instruments')) {
          historicalSeriesReads += 1
          return await new Promise<never>(() => {})
        }
        throw new Error(`Unexpected all() SQL: ${sql}`)
      },
    }),
  })

  return {
    db: { prepare } as unknown as D1Database,
    executedSql,
    historicalSeriesReads: () => historicalSeriesReads,
  }
}

async function withinTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`query exceeded ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function context(session: PortfolioReadSession) {
  return { user: session.user, session }
}

describe('AI on-demand query performance', () => {
  it('serves production-scale snapshot, quality and NAV without touching blocked history', async () => {
    const fixture = productionDatabase()
    const session = new PortfolioReadSession(fixture.db, {
      id: 'production-sized-user', email: 'owner@example.test',
    })
    const resources = createDataRegistry()
    const metrics = createMetricRegistry()

    const snapshot = await withinTimeout(resources.query('portfolio_snapshot', {}, context(session)))
    const dataQuality = await withinTimeout(resources.query('data_quality', {}, context(session)))
    const nav = await withinTimeout(metrics.getMetric('nav', {}, context(session)))

    expect(snapshot.rows[0]).toMatchObject({
      open_position_count: PRODUCTION_SYMBOL_COUNT,
      transaction_count: PRODUCTION_TRANSACTION_COUNT,
    })
    expect(dataQuality.rows).toContainEqual(expect.objectContaining({
      domain: 'PERFORMANCE', code: 'UNSUPPORTED_TOTAL_RETURN_COVERAGE',
    }))
    expect(nav).toMatchObject({ metric: 'nav', as_of: '2026-08-17' })
    expect(fixture.historicalSeriesReads()).toBe(0)
  })

  it('keeps the optimized query path read-only at the database boundary', async () => {
    const fixture = productionDatabase()
    const session = new PortfolioReadSession(fixture.db, {
      id: 'read-only-user', email: 'owner@example.test',
    })

    await withinTimeout(createDataRegistry().query('portfolio_snapshot', {}, context(session)))
    await withinTimeout(createMetricRegistry().getMetric('nav', {}, context(session)))

    expect(fixture.executedSql.length).toBeGreaterThan(0)
    expect(fixture.executedSql.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true)
  })
})
