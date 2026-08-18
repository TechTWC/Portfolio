import { describe, expect, it } from 'vitest'
import app from '../worker/index'

type RaceStatement = {
  kind: string
  bindings: unknown[]
  bind: (...values: unknown[]) => RaceStatement
  first: () => Promise<Record<string, unknown> | null>
  all: () => Promise<{ results: Record<string, unknown>[] }>
  run: () => Promise<{ success: boolean; meta: { changes: number } }>
}

function activationRaceDatabase() {
  const state = {
    transactionDatasetId: '11111111-1111-4111-8111-111111111111',
    transactionRevision: 6,
    valuationRevision: 4,
    activeSnapshotId: 'snapshot-v4',
    snapshots: new Map<string, 'ACTIVE' | 'ARCHIVED' | 'PENDING'>([['snapshot-v4', 'ACTIVE']]),
    finalConditionalUpdateReached: false,
    repairApplied: false,
    candidateDeleted: false,
  }

  const result = (changes = 1) => ({ success: true, meta: { changes } })
  const prepare = (sql: string): RaceStatement => {
    const kind = sql.includes('SELECT valuation_revision FROM valuation_state')
      ? 'valuationRevision'
      : sql.includes('SELECT active_dataset_id, cloud_revision FROM portfolio_state')
        ? 'portfolioState'
        : sql.includes('SELECT active_snapshot_id FROM valuation_state')
          ? 'valuationStateBefore'
          : sql.includes('FROM transactions t')
            ? 'transactions'
        : sql.includes('INSERT INTO users')
              || sql.includes('INSERT INTO portfolio_state')
              || sql.includes('INSERT INTO valuation_state')
              || sql.includes('INSERT INTO market_state')
              ? 'authInit'
              : sql.includes('INSERT INTO valuation_snapshots')
              ? 'insertSnapshot'
              : sql.includes('INSERT INTO valuation_marks')
                ? 'insertMark'
                : sql.includes("SET status = 'ARCHIVED'")
                  ? 'archiveActive'
                  : sql.includes("SET status = 'ACTIVE', activated_at")
                    ? 'activateCandidate'
                    : sql.includes('UPDATE valuation_state')
                      ? 'conditionalStateUpdate'
                      : sql.includes("SET status = 'PENDING'")
                        ? 'restoreCandidatePending'
                        : sql.includes("SET status = 'ACTIVE'")
                          ? 'restorePreviousActive'
                          : sql.includes('DELETE FROM valuation_snapshots')
                            ? 'deletePending'
                            : 'unexpected'

    const statement: RaceStatement = {
      kind,
      bindings: [],
      bind: (...values: unknown[]) => {
        statement.bindings = values
        return statement
      },
      first: async () => {
        if (kind === 'valuationRevision') return { valuation_revision: state.valuationRevision }
        if (kind === 'portfolioState') {
          return {
            active_dataset_id: state.transactionDatasetId,
            cloud_revision: state.transactionRevision,
          }
        }
        if (kind === 'valuationStateBefore') {
          return state.valuationRevision === statement.bindings[1]
            ? { active_snapshot_id: state.activeSnapshotId }
            : null
        }
        throw new Error(`Unexpected first query: ${sql}`)
      },
      all: async () => {
        if (kind !== 'transactions') throw new Error(`Unexpected all query: ${sql}`)
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
      },
      run: async () => {
        if (kind === 'insertSnapshot') {
          state.snapshots.set(String(statement.bindings[0]), 'PENDING')
          return result()
        }
        if (kind === 'deletePending') {
          const snapshotId = String(statement.bindings[0])
          if (state.snapshots.get(snapshotId) === 'PENDING') {
            state.snapshots.delete(snapshotId)
            state.candidateDeleted = true
            return result()
          }
          return result(0)
        }
        throw new Error(`Unexpected run query: ${sql}`)
      },
    }
    return statement
  }

  const batch = async (statements: RaceStatement[]) => statements.map((statement) => {
    if (statement.kind === 'authInit') return result()
    if (statement.kind === 'insertMark') return result()
    if (statement.kind === 'archiveActive') {
      for (const [snapshotId, status] of state.snapshots) {
        if (status === 'ACTIVE') state.snapshots.set(snapshotId, 'ARCHIVED')
      }
      return result()
    }
    if (statement.kind === 'activateCandidate') {
      state.snapshots.set(String(statement.bindings[0]), 'ACTIVE')
      return result()
    }
    if (statement.kind === 'conditionalStateUpdate') {
      state.finalConditionalUpdateReached = true
      state.transactionDatasetId = '22222222-2222-4222-8222-222222222222'
      state.transactionRevision = 7
      return result(0)
    }
    if (statement.kind === 'restoreCandidatePending') {
      state.snapshots.set(String(statement.bindings[0]), 'PENDING')
      return result()
    }
    if (statement.kind === 'restorePreviousActive') {
      state.snapshots.set(String(statement.bindings[0]), 'ACTIVE')
      state.repairApplied = true
      return result()
    }
    throw new Error(`Unexpected batch statement: ${statement.kind}`)
  })

  return {
    db: { prepare, batch } as unknown as D1Database,
    state,
  }
}

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

  it('returns 409 and preserves the previous ACTIVE valuation when transactions race final activation', async () => {
    const { db, state } = activationRaceDatabase()
    const response = await app.request('/api/valuations/activate', {
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
      DB: db,
      AUTH_MODE: 'dev',
      DEV_USER_EMAIL: 'synthetic@example.test',
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'TRANSACTION_VERSION_CONFLICT',
      baseRevision: 6,
      currentRevision: 7,
    })
    expect(state.finalConditionalUpdateReached).toBe(true)
    expect(state.repairApplied).toBe(true)
    expect(state.candidateDeleted).toBe(true)
    expect(state.valuationRevision).toBe(4)
    expect(state.activeSnapshotId).toBe('snapshot-v4')
    expect([...state.snapshots.entries()]).toEqual([['snapshot-v4', 'ACTIVE']])
  })
})
