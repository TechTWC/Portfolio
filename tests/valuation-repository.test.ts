import { describe, expect, it } from 'vitest'
import { getValuationBootstrap } from '../worker/valuation-repository'

type QueryResult = Record<string, unknown> | null

function valuationDatabase(
  currentDatasetId: string,
  currentRevision: number,
  options: { switchActiveSnapshotAfterMetadataRead?: boolean } = {},
): D1Database {
  let snapshotMetadataRead = false
  const prepare = (sql: string) => {
    let bindings: unknown[] = []
    const statement = {
      bind: (...values: unknown[]) => {
        bindings = values
        return statement
      },
      first: async (): Promise<QueryResult> => {
        if (sql.includes('FROM portfolio_state')) {
          return { active_dataset_id: currentDatasetId, cloud_revision: currentRevision }
        }
        if (sql.includes('FROM valuation_state')) {
          return { active_snapshot_id: 'snapshot-v4', valuation_revision: 4 }
        }
        if (sql.includes('FROM valuation_snapshots')) {
          snapshotMetadataRead = true
          return {
            id: 'snapshot-v4',
            revision: 4,
            status: 'ACTIVE',
            valuation_date: '2026-06-30',
            filename: 'marks.csv',
            file_hash: 'marks-hash',
            parser_version: 'valuation-test',
            mark_count: 1,
            earliest_mark_date: '2026-06-30',
            latest_mark_date: '2026-06-30',
            transaction_dataset_id: 'dataset-v6',
            transaction_revision: 6,
            created_at: '2026-07-01 00:00:00',
            activated_at: '2026-07-01 00:00:00',
          }
        }
        throw new Error(`Unexpected first query: ${sql}`)
      },
      all: async () => {
        if (sql.includes('FROM valuation_marks')) {
          const value = options.switchActiveSnapshotAfterMetadataRead
            && snapshotMetadataRead
            && sql.includes('JOIN valuation_state')
            ? 999
            : 100
          return {
            results: [{
              source_row_number: 2,
              mark_date: '2026-06-30',
              mark_type: 'PRICE',
              ticker: 'TEST',
              currency: 'TWD',
              value,
              source: 'SYNTHETIC',
              row_hash: 'mark-row',
            }],
          }
        }
        if (sql.includes('FROM transactions t')) {
          expect(bindings[0]).toBe('dataset-v6')
          return {
            results: [{
              transaction_id: 'transaction-stable-1',
              source_row_number: 2,
              trade_date: '2026-01-01',
              transaction_type: 'SECURITY',
              ticker: 'TEST',
              currency: 'TWD',
              quantity: 1,
              price: 50,
              amount_foreign: 50,
              fx_rate: 1,
              fee: 0,
              budget_waterline: null,
              budget_balance: null,
              note: '',
              row_hash: 'transaction-row',
            }],
          }
        }
        throw new Error(`Unexpected all query: ${sql}`)
      },
    }
    return statement
  }

  return { prepare } as unknown as D1Database
}

describe('valuation repository transaction lineage', () => {
  it('rebuilds a stale valuation from its bound dataset instead of current transactions', async () => {
    const result = await getValuationBootstrap(
      valuationDatabase('dataset-v7', 7),
      { id: 'user-1', email: 'synthetic@example.test' },
    )

    expect(result.freshness).toBe('STALE')
    expect(result.currentTransactionRevision).toBe(7)
    expect(result.activeSnapshot).toMatchObject({
      transactionDatasetId: 'dataset-v6',
      transactionRevision: 6,
    })
    expect(result.transactions[0]?.transactionId).toBe('transaction-stable-1')
    expect(result.valuation?.totalAssetsTwd).toBe(100)
  })

  it('reports current when the active transaction binding still matches', async () => {
    const result = await getValuationBootstrap(
      valuationDatabase('dataset-v6', 6),
      { id: 'user-1', email: 'synthetic@example.test' },
    )

    expect(result.freshness).toBe('CURRENT')
    expect(result.valuation?.totalAssetsTwd).toBe(100)
  })

  it('uses marks from the captured snapshot when another tab changes active valuation state', async () => {
    const result = await getValuationBootstrap(
      valuationDatabase('dataset-v6', 6, { switchActiveSnapshotAfterMetadataRead: true }),
      { id: 'user-1', email: 'synthetic@example.test' },
    )

    expect(result.activeSnapshot?.id).toBe('snapshot-v4')
    expect(result.marks[0]?.value).toBe(100)
    expect(result.valuation?.totalAssetsTwd).toBe(100)
  })
})
