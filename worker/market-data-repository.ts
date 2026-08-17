import {
  MARKET_DATA_PROVIDER,
  type MarketDataBootstrapResponse,
  type MarketDataInstrumentSummary,
  type MarketDataRunSummary,
  type MarketInstrumentFetchResult,
} from '../src/lib/market-data-contracts'
import type { NormalizedValuationMark } from '../src/lib/valuation-contracts'
import { sha256Hex } from '../src/lib/hash'
import { getPortfolioState } from './repository'

type User = { id: string; email: string }

type MarketStateRow = { active_run_id: string | null; market_revision: number }

type RunRow = {
  id: string
  revision: number
  status: MarketDataRunSummary['status']
  provider: typeof MARKET_DATA_PROVIDER
  data_version: string
  benchmark_ticker: string
  transaction_dataset_id: string
  transaction_revision: number
  instrument_count: number
  bar_count: number
  earliest_bar_date: string | null
  latest_bar_date: string | null
  fetched_at: string
  activated_at: string | null
}

type InstrumentRow = {
  instrument_type: MarketDataInstrumentSummary['instrumentType']
  ticker: string
  currency: string
  provider_symbol: string
  exchange_timezone: string
  bar_count: number
  earliest_bar_date: string
  latest_bar_date: string
  latest_raw_close: number
}

type SeriesRow = {
  instrument_type: 'SECURITY' | 'FX' | 'BENCHMARK'
  ticker: string
  currency: string
  bars_json: string
}

export type MarketObservationInsert = {
  instrumentType: 'SECURITY' | 'FX' | 'BENCHMARK'
  ticker: string
  currency: string
  providerSymbol: string
  exchangeTimezone: string
  date: string
  rawClose: number
  adjustedClose: number | null
  rowHash: string
}

function runSummary(row: RunRow): MarketDataRunSummary {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    provider: row.provider,
    dataVersion: row.data_version,
    benchmarkTicker: row.benchmark_ticker,
    transactionDatasetId: row.transaction_dataset_id,
    transactionRevision: row.transaction_revision,
    instrumentCount: row.instrument_count,
    barCount: row.bar_count,
    earliestBarDate: row.earliest_bar_date,
    latestBarDate: row.latest_bar_date,
    fetchedAt: row.fetched_at,
    activatedAt: row.activated_at,
  }
}

function instrumentSummary(row: InstrumentRow): MarketDataInstrumentSummary {
  return {
    instrumentType: row.instrument_type,
    ticker: row.ticker,
    currency: row.currency,
    providerSymbol: row.provider_symbol,
    exchangeTimezone: row.exchange_timezone,
    barCount: row.bar_count,
    earliestBarDate: row.earliest_bar_date,
    latestBarDate: row.latest_bar_date,
    latestRawClose: row.latest_raw_close,
  }
}

export async function getMarketState(db: D1Database, userId: string): Promise<MarketStateRow> {
  const row = await db.prepare(
    'SELECT active_run_id, market_revision FROM market_state WHERE user_id = ?',
  ).bind(userId).first<MarketStateRow>()
  return row ?? { active_run_id: null, market_revision: 0 }
}

export async function latestMarketDates(
  db: D1Database,
  userId: string,
): Promise<Map<string, string>> {
  const state = await getMarketState(db, userId)
  if (!state.active_run_id || state.market_revision === 0) return new Map()
  const rows = await db.prepare(
    `SELECT instrument.instrument_type, instrument.ticker, instrument.currency,
            MAX(instrument.latest_bar_date) AS latest_bar_date
       FROM market_data_instruments instrument
       JOIN market_data_runs run ON run.id = instrument.run_id
      WHERE instrument.user_id = ? AND run.revision <= ?
        AND run.status IN ('ACTIVE', 'ARCHIVED')
      GROUP BY instrument.instrument_type, instrument.ticker, instrument.currency`,
  ).bind(userId, state.market_revision).all<{
    instrument_type: string
    ticker: string
    currency: string
    latest_bar_date: string
  }>()
  return new Map(rows.results.map((row) => [
    `${row.instrument_type}\u0000${row.ticker}\u0000${row.currency}`,
    row.latest_bar_date,
  ]))
}

export async function createPendingMarketRun(
  db: D1Database,
  user: User,
  input: {
    transactionDatasetId: string
    transactionRevision: number
    dataVersion: string
    benchmarkTicker: string
    fetchedAt: string
    results: MarketInstrumentFetchResult[]
    observations: MarketObservationInsert[]
  },
): Promise<{ id: string; revision: number; baseRevision: number; previousActiveRunId: string | null }> {
  const state = await getMarketState(db, user.id)
  const latestRun = await db.prepare(
    'SELECT MAX(revision) AS maximum_revision FROM market_data_runs WHERE user_id = ?',
  ).bind(user.id).first<{ maximum_revision: number | null }>()
  const revision = Math.max(state.market_revision, latestRun?.maximum_revision ?? 0) + 1
  const id = crypto.randomUUID()
  const allDates = input.observations.map((row) => row.date).sort()

  await db.prepare(
    `INSERT INTO market_data_runs
       (id, user_id, revision, status, provider, data_version, benchmark_ticker,
        transaction_dataset_id, transaction_revision, instrument_count, bar_count,
        earliest_bar_date, latest_bar_date, validation_json, fetched_at)
     VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    user.id,
    revision,
    MARKET_DATA_PROVIDER,
    input.dataVersion,
    input.benchmarkTicker,
    input.transactionDatasetId,
    input.transactionRevision,
    input.results.length,
    input.observations.length,
    allDates[0] ?? null,
    allDates.at(-1) ?? null,
    JSON.stringify({ complete: true, rawCloseBasis: true }),
    input.fetchedAt,
  ).run()

  try {
    const instrumentStatements = await Promise.all(input.results.map(async (result) => {
      const bars = input.observations
        .filter((row) => row.instrumentType === result.instrumentType
          && row.ticker === result.ticker
          && row.currency === result.currency)
        .map((row) => ({
          date: row.date,
          rawClose: row.rawClose,
          adjustedClose: row.adjustedClose,
          rowHash: row.rowHash,
        }))
      const seriesHash = await sha256Hex(bars.map((bar) => bar.rowHash).join('|'))
      return db.prepare(
        `INSERT INTO market_data_instruments
          (id, run_id, user_id, instrument_type, ticker, currency, provider_symbol,
           exchange_timezone, bar_count, earliest_bar_date, latest_bar_date, latest_raw_close,
           series_hash, bars_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        id,
        user.id,
        result.instrumentType,
        result.ticker,
        result.currency,
        result.providerSymbol,
        result.exchangeTimezone,
        result.bars.length,
        result.bars[0]?.date,
        result.latestCloseDate,
        result.latestRawClose,
        seriesHash,
        JSON.stringify(bars),
      )
    }))
    await db.batch(instrumentStatements)
  } catch (error) {
    await db.prepare(
      `UPDATE market_data_runs SET status = 'FAILED', validation_json = ?
        WHERE id = ? AND user_id = ? AND status = 'PENDING'`,
    ).bind(JSON.stringify({ complete: false, error: error instanceof Error ? error.message : String(error) }), id, user.id).run()
    throw error
  }

  return {
    id,
    revision,
    baseRevision: state.market_revision,
    previousActiveRunId: state.active_run_id,
  }
}

export async function activateMarketRun(
  db: D1Database,
  userId: string,
  run: {
    id: string
    revision: number
    baseRevision: number
    previousActiveRunId: string | null
  },
  binding: { transactionDatasetId: string; transactionRevision: number },
): Promise<void> {
  const results = await db.batch([
    db.prepare(
      `UPDATE market_data_runs SET status = 'ARCHIVED'
        WHERE user_id = ? AND status = 'ACTIVE'`,
    ).bind(userId),
    db.prepare(
      `UPDATE market_data_runs SET status = 'ACTIVE', activated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND revision = ? AND status = 'PENDING'`,
    ).bind(run.id, userId, run.revision),
    db.prepare(
      `UPDATE market_state
          SET active_run_id = ?, market_revision = ?, updated_at = datetime('now')
        WHERE user_id = ? AND market_revision = ? AND active_run_id IS ?
          AND EXISTS (
            SELECT 1 FROM market_data_runs candidate
             WHERE candidate.id = ? AND candidate.user_id = ? AND candidate.status = 'ACTIVE'
          )
          AND EXISTS (
            SELECT 1 FROM portfolio_state portfolio
             WHERE portfolio.user_id = ?
               AND portfolio.active_dataset_id = ?
               AND portfolio.cloud_revision = ?
          )`,
    ).bind(
      run.id, run.revision, userId, run.baseRevision, run.previousActiveRunId,
      run.id, userId,
      userId, binding.transactionDatasetId, binding.transactionRevision,
    ),
  ])
  const stateUpdate = results.at(-1)
  if (!stateUpdate?.success || stateUpdate.meta.changes !== 1) {
    await db.batch([
      db.prepare(
        `UPDATE market_data_runs SET status = 'FAILED'
          WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`,
      ).bind(run.id, userId),
      ...(run.previousActiveRunId ? [db.prepare(
        `UPDATE market_data_runs SET status = 'ACTIVE'
          WHERE id = ? AND user_id = ? AND status = 'ARCHIVED'`,
      ).bind(run.previousActiveRunId, userId)] : []),
    ])
    throw new Error('MARKET_DATA_VERSION_CONFLICT')
  }
}

export async function getMarketDataBootstrap(
  db: D1Database,
  user: User,
  includeMarks = true,
): Promise<MarketDataBootstrapResponse> {
  const portfolio = await getPortfolioState(db, user.id)
  const state = await getMarketState(db, user.id)
  if (!state.active_run_id) {
    return {
      marketRevision: state.market_revision,
      currentTransactionDatasetId: portfolio.activeDatasetId,
      currentTransactionRevision: portfolio.cloudRevision,
      freshness: 'NO_RUN',
      activeRun: null,
      instruments: [],
      marks: [],
    }
  }

  const run = await db.prepare(
    `SELECT id, revision, status, provider, data_version, benchmark_ticker,
            transaction_dataset_id, transaction_revision, instrument_count, bar_count,
            earliest_bar_date, latest_bar_date, fetched_at, activated_at
       FROM market_data_runs WHERE id = ? AND user_id = ?`,
  ).bind(state.active_run_id, user.id).first<RunRow>()
  if (!run) throw new Error('ACTIVE market-data run metadata is missing')

  const instrumentRows = await db.prepare(
    `SELECT instrument_type, ticker, currency, provider_symbol, exchange_timezone,
            bar_count, earliest_bar_date, latest_bar_date, latest_raw_close
       FROM market_data_instruments WHERE run_id = ? AND user_id = ?
      ORDER BY instrument_type, currency, ticker`,
  ).bind(run.id, user.id).all<InstrumentRow>()

  const seriesRows = includeMarks ? await db.prepare(
    `SELECT instrument.instrument_type, instrument.ticker, instrument.currency,
            instrument.bars_json
       FROM market_data_instruments instrument
       JOIN market_data_runs run ON run.id = instrument.run_id
      WHERE instrument.user_id = ? AND run.revision <= ?
        AND run.status IN ('ACTIVE', 'ARCHIVED')
      ORDER BY run.revision, instrument.instrument_type, instrument.currency, instrument.ticker`,
  ).bind(user.id, state.market_revision).all<SeriesRow>() : { results: [] }

  const markByKey = new Map<string, Omit<NormalizedValuationMark, 'sourceRowNumber'>>()
  for (const row of seriesRows.results) {
    const bars = JSON.parse(row.bars_json) as Array<{
      date: string
      rawClose: number
      adjustedClose: number | null
      rowHash: string
    }>
    for (const bar of bars) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date) || !Number.isFinite(bar.rawClose) || bar.rawClose <= 0) {
        throw new Error('ACTIVE market-data series contains an invalid bar')
      }
      const key = `${row.instrument_type}\u0000${row.ticker}\u0000${row.currency}\u0000${bar.date}`
      markByKey.set(key, {
        markDate: bar.date,
        markType: row.instrument_type === 'FX' ? 'FX' : 'PRICE',
        ticker: row.instrument_type === 'FX' ? '' : row.ticker,
        currency: row.currency,
        value: bar.rawClose,
        source: `${MARKET_DATA_PROVIDER}:RAW_CLOSE`,
        rowHash: bar.rowHash,
      })
    }
  }
  const marks: NormalizedValuationMark[] = [...markByKey.values()]
    .sort((a, b) => a.markDate.localeCompare(b.markDate)
      || a.markType.localeCompare(b.markType)
      || a.currency.localeCompare(b.currency)
      || a.ticker.localeCompare(b.ticker))
    .map((mark, index) => ({ ...mark, sourceRowNumber: index + 1 }))

  return {
    marketRevision: state.market_revision,
    currentTransactionDatasetId: portfolio.activeDatasetId,
    currentTransactionRevision: portfolio.cloudRevision,
    freshness: run.transaction_dataset_id === portfolio.activeDatasetId
      && run.transaction_revision === portfolio.cloudRevision ? 'CURRENT' : 'STALE',
    activeRun: runSummary(run),
    instruments: instrumentRows.results.map(instrumentSummary),
    marks,
  }
}
