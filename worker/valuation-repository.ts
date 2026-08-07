import { buildPortfolioAccounting } from '../src/lib/accounting'
import { buildCashFundingLedger } from '../src/lib/cash-ledger'
import {
  type NormalizedValuationMark,
  type ValuationBootstrapResponse,
  type ValuationSnapshotSummary,
  type ValuationSnapshotUpload,
  toValuationMark,
} from '../src/lib/valuation-contracts'
import { buildPointInTimeValuation } from '../src/lib/valuation'
import { determineValuationFreshness, transactionBindingMatches } from '../src/lib/valuation-lineage'
import { getPortfolioState, getTransactionsForDataset } from './repository'

type User = { id: string; email: string }

type SnapshotRow = {
  id: string
  revision: number
  status: ValuationSnapshotSummary['status']
  valuation_date: string
  filename: string
  file_hash: string
  parser_version: string
  mark_count: number
  earliest_mark_date: string | null
  latest_mark_date: string | null
  transaction_dataset_id: string
  transaction_revision: number
  created_at: string
  activated_at: string | null
}

type MarkRow = {
  source_row_number: number
  mark_date: string
  mark_type: NormalizedValuationMark['markType']
  ticker: string
  currency: string
  value: number
  source: string
  row_hash: string
}

function snapshotSummary(row: SnapshotRow): ValuationSnapshotSummary {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    valuationDate: row.valuation_date,
    filename: row.filename,
    fileHash: row.file_hash,
    parserVersion: row.parser_version,
    markCount: row.mark_count,
    earliestMarkDate: row.earliest_mark_date,
    latestMarkDate: row.latest_mark_date,
    transactionDatasetId: row.transaction_dataset_id,
    transactionRevision: row.transaction_revision,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  }
}

function markFromRow(row: MarkRow): NormalizedValuationMark {
  return {
    sourceRowNumber: row.source_row_number,
    markDate: row.mark_date,
    markType: row.mark_type,
    ticker: row.ticker,
    currency: row.currency,
    value: row.value,
    source: row.source,
    rowHash: row.row_hash,
  }
}

export async function currentValuationRevision(db: D1Database, userId: string): Promise<number> {
  const state = await db.prepare(
    'SELECT valuation_revision FROM valuation_state WHERE user_id = ?',
  ).bind(userId).first<{ valuation_revision: number }>()
  return state?.valuation_revision ?? 0
}

export async function getActiveValuationMarks(
  db: D1Database,
  userId: string,
): Promise<NormalizedValuationMark[]> {
  const rows = await db.prepare(
    `SELECT m.source_row_number, m.mark_date, m.mark_type, m.ticker,
            m.currency, m.value, m.source, m.row_hash
       FROM valuation_marks m
       JOIN valuation_state s ON s.active_snapshot_id = m.snapshot_id
      WHERE s.user_id = ? AND m.user_id = ?
      ORDER BY m.mark_date, m.mark_type, m.ticker, m.currency, m.source_row_number`,
  ).bind(userId, userId).all<MarkRow>()
  return rows.results.map(markFromRow)
}

async function getValuationMarksForSnapshot(
  db: D1Database,
  userId: string,
  snapshotId: string,
): Promise<NormalizedValuationMark[]> {
  const rows = await db.prepare(
    `SELECT source_row_number, mark_date, mark_type, ticker,
            currency, value, source, row_hash
       FROM valuation_marks
      WHERE snapshot_id = ? AND user_id = ?
      ORDER BY mark_date, mark_type, ticker, currency, source_row_number`,
  ).bind(snapshotId, userId).all<MarkRow>()
  return rows.results.map(markFromRow)
}

export async function getValuationBootstrap(
  db: D1Database,
  user: User,
): Promise<ValuationBootstrapResponse> {
  const currentTransactions = await getPortfolioState(db, user.id)
  const state = await db.prepare(
    'SELECT active_snapshot_id, valuation_revision FROM valuation_state WHERE user_id = ?',
  ).bind(user.id).first<{ active_snapshot_id: string | null; valuation_revision: number }>()

  if (!state?.active_snapshot_id) {
    return {
      valuationRevision: state?.valuation_revision ?? 0,
      currentTransactionDatasetId: currentTransactions.activeDatasetId,
      currentTransactionRevision: currentTransactions.cloudRevision,
      freshness: 'NO_SNAPSHOT',
      activeSnapshot: null,
      marks: [],
      transactions: [],
      valuation: null,
    }
  }

  const snapshot = await db.prepare(
    `SELECT id, revision, status, valuation_date, filename, file_hash,
            parser_version, mark_count, earliest_mark_date, latest_mark_date,
            transaction_dataset_id, transaction_revision, created_at, activated_at
       FROM valuation_snapshots
      WHERE id = ? AND user_id = ?`,
  ).bind(state.active_snapshot_id, user.id).first<SnapshotRow>()

  if (!snapshot) {
    return {
      valuationRevision: state.valuation_revision,
      currentTransactionDatasetId: currentTransactions.activeDatasetId,
      currentTransactionRevision: currentTransactions.cloudRevision,
      freshness: 'NO_SNAPSHOT',
      activeSnapshot: null,
      marks: [],
      transactions: [],
      valuation: null,
    }
  }

  const marks = await getValuationMarksForSnapshot(db, user.id, snapshot.id)
  const transactions = await getTransactionsForDataset(db, user.id, snapshot.transaction_dataset_id)
  const accounting = buildPortfolioAccounting(transactions)
  const cashLedger = buildCashFundingLedger(transactions)
  const valuation = buildPointInTimeValuation({
    valuationDate: snapshot.valuation_date,
    positions: accounting.positions,
    wallets: cashLedger.wallets,
    marks: marks.map(toValuationMark),
  })

  return {
    valuationRevision: state.valuation_revision,
    currentTransactionDatasetId: currentTransactions.activeDatasetId,
    currentTransactionRevision: currentTransactions.cloudRevision,
    freshness: determineValuationFreshness({
      transactionDatasetId: snapshot.transaction_dataset_id,
      transactionRevision: snapshot.transaction_revision,
    }, currentTransactions),
    activeSnapshot: snapshotSummary(snapshot),
    marks,
    transactions,
    valuation,
  }
}

function markDateRange(payload: ValuationSnapshotUpload): { earliest: string; latest: string } {
  const dates = payload.marks.map((mark) => mark.markDate).sort()
  return { earliest: dates[0], latest: dates[dates.length - 1] }
}

export async function activateValuationSnapshot(
  db: D1Database,
  user: User,
  payload: ValuationSnapshotUpload,
  validation: Record<string, unknown>,
): Promise<void> {
  const revision = payload.baseRevision + 1
  const snapshotId = crypto.randomUUID()
  const { earliest, latest } = markDateRange(payload)
  const stateBefore = await db.prepare(
    'SELECT active_snapshot_id FROM valuation_state WHERE user_id = ? AND valuation_revision = ?',
  ).bind(user.id, payload.baseRevision).first<{ active_snapshot_id: string | null }>()
  if (!stateBefore) throw new Error('VALUATION_VERSION_CONFLICT')
  const currentTransactionsBefore = await getPortfolioState(db, user.id)
  if (!transactionBindingMatches({
    transactionDatasetId: payload.transactionDatasetId,
    transactionRevision: payload.transactionRevision,
  }, currentTransactionsBefore)) {
    throw new Error('TRANSACTION_VERSION_CONFLICT')
  }

  await db.prepare(
    `INSERT INTO valuation_snapshots
       (id, user_id, revision, status, valuation_date, filename, file_hash,
        parser_version, mark_count, earliest_mark_date, latest_mark_date, validation_json,
        transaction_dataset_id, transaction_revision)
     VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    snapshotId,
    user.id,
    revision,
    payload.valuationDate,
    payload.filename,
    payload.fileHash,
    payload.parserVersion,
    payload.marks.length,
    earliest,
    latest,
    JSON.stringify(validation),
    payload.transactionDatasetId,
    payload.transactionRevision,
  ).run()

  try {
    const chunkSize = 100
    for (let offset = 0; offset < payload.marks.length; offset += chunkSize) {
      const chunk = payload.marks.slice(offset, offset + chunkSize)
      const statements = chunk.map((mark) => db.prepare(
        `INSERT INTO valuation_marks
          (id, snapshot_id, user_id, source_row_number, mark_date, mark_type,
           ticker, currency, value, source, row_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        snapshotId,
        user.id,
        mark.sourceRowNumber,
        mark.markDate,
        mark.markType,
        mark.ticker,
        mark.currency,
        mark.value,
        mark.source,
        mark.rowHash,
      ))
      await db.batch(statements)
    }

    const current = await currentValuationRevision(db, user.id)
    if (current !== payload.baseRevision) throw new Error('VALUATION_VERSION_CONFLICT')
    const currentTransactions = await getPortfolioState(db, user.id)
    if (!transactionBindingMatches({
      transactionDatasetId: payload.transactionDatasetId,
      transactionRevision: payload.transactionRevision,
    }, currentTransactions)) {
      throw new Error('TRANSACTION_VERSION_CONFLICT')
    }

    const activationResults = await db.batch([
      db.prepare(
        `UPDATE valuation_snapshots
            SET status = 'ARCHIVED'
          WHERE user_id = ? AND status = 'ACTIVE'`,
      ).bind(user.id),
      db.prepare(
        `UPDATE valuation_snapshots
            SET status = 'ACTIVE', activated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND status = 'PENDING'`,
      ).bind(snapshotId, user.id),
      db.prepare(
        `UPDATE valuation_state
            SET active_snapshot_id = ?, valuation_revision = ?, updated_at = datetime('now')
          WHERE user_id = ? AND valuation_revision = ?
            AND EXISTS (
              SELECT 1
                FROM portfolio_state portfolio
               WHERE portfolio.user_id = ?
                 AND portfolio.active_dataset_id = ?
                 AND portfolio.cloud_revision = ?
            )`,
      ).bind(
        snapshotId,
        revision,
        user.id,
        payload.baseRevision,
        user.id,
        payload.transactionDatasetId,
        payload.transactionRevision,
      ),
    ])

    const stateUpdate = activationResults.at(-1)
    if (!stateUpdate?.success || stateUpdate.meta.changes !== 1) {
      const repair = [
        db.prepare(
          `UPDATE valuation_snapshots
              SET status = 'PENDING', activated_at = NULL
            WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`,
        ).bind(snapshotId, user.id),
      ]
      if (stateBefore.active_snapshot_id) {
        repair.push(db.prepare(
          `UPDATE valuation_snapshots
              SET status = 'ACTIVE'
            WHERE id = ? AND user_id = ? AND status = 'ARCHIVED'`,
        ).bind(stateBefore.active_snapshot_id, user.id))
      }
      await db.batch(repair)
      const latestTransactions = await getPortfolioState(db, user.id)
      if (!transactionBindingMatches({
        transactionDatasetId: payload.transactionDatasetId,
        transactionRevision: payload.transactionRevision,
      }, latestTransactions)) {
        throw new Error('TRANSACTION_VERSION_CONFLICT')
      }
      throw new Error('VALUATION_VERSION_CONFLICT')
    }
  } catch (error) {
    await db.prepare(
      `DELETE FROM valuation_snapshots
        WHERE id = ? AND user_id = ? AND status = 'PENDING'`,
    ).bind(snapshotId, user.id).run()
    throw error
  }
}
