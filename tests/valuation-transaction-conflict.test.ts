import { describe, expect, it } from 'vitest'
import app from '../worker/index'

function conflictDatabase(): D1Database {
  const prepare = (sql: string) => {
    const statement = {
      bind: (..._values: unknown[]) => statement,
      first: async () => {
        if (sql.includes('SELECT valuation_revision FROM valuation_state')) {
          return { valuation_revision: 4 }
        }
        if (sql.includes('SELECT active_dataset_id, cloud_revision FROM portfolio_state')) {
          return {
            active_dataset_id: '22222222-2222-4222-8222-222222222222',
            cloud_revision: 7,
          }
        }
        throw new Error(`Unexpected query: ${sql}`)
      },
    }
    return statement
  }
  return {
    prepare,
    batch: async (statements: unknown[]) => statements.map(() => ({
      success: true,
      meta: { changes: 1 },
    })),
  } as unknown as D1Database
}

describe('valuation preview transaction race protection', () => {
  it('rejects a candidate when transactions changed after the candidate was prepared', async () => {
    const response = await app.request('/api/valuations/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 4,
        transactionDatasetId: '11111111-1111-4111-8111-111111111111',
        transactionRevision: 6,
        valuationDate: '2026-06-30',
        filename: 'marks.csv',
        fileHash: 'a'.repeat(64),
        parserVersion: 'valuation-test',
        sourceRowCount: 1,
        rejectedRowCount: 0,
        marks: [{
          sourceRowNumber: 2,
          markDate: '2026-06-30',
          markType: 'PRICE',
          ticker: 'TEST',
          currency: 'TWD',
          value: 100,
          source: 'SYNTHETIC',
          rowHash: 'b'.repeat(64),
        }],
      }),
    }, {
      DB: conflictDatabase(),
      AUTH_MODE: 'dev',
      DEV_USER_EMAIL: 'synthetic@example.test',
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'TRANSACTION_VERSION_CONFLICT',
      baseRevision: 6,
      currentRevision: 7,
    })
  })
})
