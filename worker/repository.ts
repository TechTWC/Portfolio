import type {
  BootstrapResponse,
  DatasetSummary,
  DatasetUpload,
  StoredTransaction,
} from '../src/lib/contracts'
import { planTransactionLineage } from '../src/lib/transaction-lineage'

type User = { id: string; email: string }

type DatasetRow = {
  id: string
  revision: number
  status: DatasetSummary['status']
  filename: string
  file_hash: string
  parser_version: string
  row_count: number
  earliest_date: string | null
  latest_date: string | null
  created_at: string
  activated_at: string | null
}

type TransactionRow = {
  transaction_id: string
  source_row_number: number
  trade_date: string
  transaction_type: StoredTransaction['transactionType']
  ticker: string
  currency: string
  quantity: number
  price: number
  amount_foreign: number
  fx_rate: number | null
  fee: number
  budget_waterline: number | null
  budget_balance: number | null
  note: string
  row_hash: string
}

function datasetSummary(row: DatasetRow): DatasetSummary {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    filename: row.filename,
    fileHash: row.file_hash,
    parserVersion: row.parser_version,
    rowCount: row.row_count,
    earliestDate: row.earliest_date,
    latestDate: row.latest_date,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  }
}

function transactionFromRow(row: TransactionRow): StoredTransaction {
  return {
    transactionId: row.transaction_id,
    sourceRowNumber: row.source_row_number,
    tradeDate: row.trade_date,
    transactionType: row.transaction_type,
    ticker: row.ticker,
    currency: row.currency,
    quantity: row.quantity,
    price: row.price,
    amountForeign: row.amount_foreign,
    fxRate: row.fx_rate,
    fee: row.fee,
    budgetWaterline: row.budget_waterline,
    budgetBalance: row.budget_balance,
    note: row.note,
    rowHash: row.row_hash,
  }
}

export async function getBootstrap(db: D1Database, user: User): Promise<BootstrapResponse> {
  const state = await db.prepare(
    'SELECT active_dataset_id, cloud_revision FROM portfolio_state WHERE user_id = ?',
  ).bind(user.id).first<{ active_dataset_id: string | null; cloud_revision: number }>()

  if (!state?.active_dataset_id) {
    return { user, cloudRevision: state?.cloud_revision ?? 0, activeDataset: null, transactions: [] }
  }

  const dataset = await db.prepare(
    `SELECT id, revision, status, filename, file_hash, parser_version, row_count,
            earliest_date, latest_date, created_at, activated_at
       FROM portfolio_datasets WHERE id = ? AND user_id = ?`,
  ).bind(state.active_dataset_id, user.id).first<DatasetRow>()

  if (!dataset) {
    return { user, cloudRevision: state.cloud_revision, activeDataset: null, transactions: [] }
  }

  const rows = await db.prepare(
    `SELECT transaction_id, source_row_number, trade_date, transaction_type, ticker, currency,
            quantity, price, amount_foreign, fx_rate, fee, budget_waterline,
            budget_balance, note, row_hash
       FROM transactions
      WHERE dataset_id = ? AND user_id = ?
      ORDER BY trade_date, source_row_number`,
  ).bind(dataset.id, user.id).all<TransactionRow>()

  return {
    user,
    cloudRevision: state.cloud_revision,
    activeDataset: datasetSummary(dataset),
    transactions: rows.results.map(transactionFromRow),
  }
}

export type PortfolioState = {
  activeDatasetId: string | null
  cloudRevision: number
}

export async function getPortfolioState(db: D1Database, userId: string): Promise<PortfolioState> {
  const state = await db.prepare(
    'SELECT active_dataset_id, cloud_revision FROM portfolio_state WHERE user_id = ?',
  ).bind(userId).first<{ active_dataset_id: string | null; cloud_revision: number }>()
  return {
    activeDatasetId: state?.active_dataset_id ?? null,
    cloudRevision: state?.cloud_revision ?? 0,
  }
}

export async function getTransactionsForDataset(
  db: D1Database,
  userId: string,
  datasetId: string,
): Promise<StoredTransaction[]> {
  const rows = await db.prepare(
    `SELECT t.transaction_id, t.source_row_number, t.trade_date, t.transaction_type, t.ticker, t.currency,
            t.quantity, t.price, t.amount_foreign, t.fx_rate, t.fee,
            t.budget_waterline, t.budget_balance, t.note, t.row_hash
       FROM transactions t
      WHERE t.dataset_id = ? AND t.user_id = ?
      ORDER BY t.trade_date, t.source_row_number`,
  ).bind(datasetId, userId).all<TransactionRow>()
  return rows.results.map(transactionFromRow)
}

export async function getActiveTransactions(db: D1Database, userId: string): Promise<StoredTransaction[]> {
  const state = await getPortfolioState(db, userId)
  if (!state.activeDatasetId) return []
  return getTransactionsForDataset(db, userId, state.activeDatasetId)
}

export async function currentRevision(db: D1Database, userId: string): Promise<number> {
  return (await getPortfolioState(db, userId)).cloudRevision
}

function dateRange(payload: DatasetUpload): { earliest: string; latest: string } {
  const dates = payload.transactions.map((row) => row.tradeDate).sort()
  return { earliest: dates[0], latest: dates[dates.length - 1] }
}

export async function activateDataset(
  db: D1Database,
  user: User,
  payload: DatasetUpload,
  validation: Record<string, unknown>,
): Promise<void> {
  const revision = payload.baseRevision + 1
  const datasetId = crypto.randomUUID()
  const { earliest, latest } = dateRange(payload)
  const stateBefore = await db.prepare(
    'SELECT active_dataset_id FROM portfolio_state WHERE user_id = ? AND cloud_revision = ?',
  ).bind(user.id, payload.baseRevision).first<{ active_dataset_id: string | null }>()
  if (!stateBefore) throw new Error('VERSION_CONFLICT')
  const previousTransactions = stateBefore.active_dataset_id
    ? await getTransactionsForDataset(db, user.id, stateBefore.active_dataset_id)
    : []
  const lineage = planTransactionLineage(previousTransactions, payload.transactions)

  await db.prepare(
    `INSERT INTO portfolio_datasets
       (id, user_id, revision, status, filename, file_hash, parser_version,
        row_count, earliest_date, latest_date, validation_json)
     VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    datasetId,
    user.id,
    revision,
    payload.filename,
    payload.fileHash,
    payload.parserVersion,
    payload.transactions.length,
    earliest,
    latest,
    JSON.stringify({ ...validation, transactionLineage: lineage.summary }),
  ).run()

  try {
    const chunkSize = 100
    for (let offset = 0; offset < payload.transactions.length; offset += chunkSize) {
      const chunk = lineage.rows.slice(offset, offset + chunkSize)
      const statements = chunk.map(({ transaction: row, transactionId }) => db.prepare(
        `INSERT INTO transactions
          (id, dataset_id, user_id, transaction_id, source_row_number, trade_date, transaction_type,
           ticker, currency, quantity, price, amount_foreign, fx_rate, fee,
           budget_waterline, budget_balance, note, row_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        datasetId,
        user.id,
        transactionId ?? crypto.randomUUID(),
        row.sourceRowNumber,
        row.tradeDate,
        row.transactionType,
        row.ticker,
        row.currency,
        row.quantity,
        row.price,
        row.amountForeign,
        row.fxRate,
        row.fee,
        row.budgetWaterline,
        row.budgetBalance,
        row.note,
        row.rowHash,
      ))
      await db.batch(statements)
    }

    const current = await currentRevision(db, user.id)
    if (current !== payload.baseRevision) throw new Error('VERSION_CONFLICT')

    const activationResults = await db.batch([
      db.prepare(
        `UPDATE portfolio_datasets
            SET status = 'ARCHIVED'
          WHERE user_id = ? AND status = 'ACTIVE'`,
      ).bind(user.id),
      db.prepare(
        `UPDATE portfolio_datasets
            SET status = 'ACTIVE', activated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND status = 'PENDING'`,
      ).bind(datasetId, user.id),
      db.prepare(
        `UPDATE portfolio_state
            SET active_dataset_id = ?, cloud_revision = ?, updated_at = datetime('now')
          WHERE user_id = ? AND cloud_revision = ?`,
      ).bind(datasetId, revision, user.id, payload.baseRevision),
    ])

    const stateUpdate = activationResults.at(-1)
    if (!stateUpdate?.success || stateUpdate.meta.changes !== 1) {
      const repair = [
        db.prepare(
          `UPDATE portfolio_datasets
              SET status = 'PENDING', activated_at = NULL
            WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`,
        ).bind(datasetId, user.id),
      ]
      if (stateBefore.active_dataset_id) {
        repair.push(db.prepare(
          `UPDATE portfolio_datasets
              SET status = 'ACTIVE'
            WHERE id = ? AND user_id = ? AND status = 'ARCHIVED'`,
        ).bind(stateBefore.active_dataset_id, user.id))
      }
      await db.batch(repair)
      throw new Error('VERSION_CONFLICT')
    }
  } catch (error) {
    // Technical failures must not reserve the same revision/file hash forever.
    // Deleting the still-PENDING dataset cascades its partial rows and lets the
    // user retry without touching the previous ACTIVE version.
    await db.prepare(
      `DELETE FROM portfolio_datasets WHERE id = ? AND user_id = ? AND status = 'PENDING'`,
    ).bind(datasetId, user.id).run()
    throw error
  }
}
