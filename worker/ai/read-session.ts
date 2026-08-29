import { buildPortfolioAccounting } from '../../src/lib/accounting'
import { buildCashFundingLedger } from '../../src/lib/cash-ledger'
import type { StoredTransaction } from '../../src/lib/contracts'
import { buildFxCostPool } from '../../src/lib/fx-cost-pool'
import { deriveHistoricalNavDates } from '../../src/lib/historical-nav-schedule'
import { buildCurrentPerformance } from '../../src/lib/performance'
import {
  buildHistoricalPerformanceSeries,
  type HistoricalPerformanceSeries,
} from '../../src/lib/time-weighted-performance'
import type { NormalizedValuationMark } from '../../src/lib/valuation-contracts'
import { toValuationMark } from '../../src/lib/valuation-contracts'
import { buildPointInTimeValuation } from '../../src/lib/valuation'
import { reconcileValuationWithTwdCost } from '../../src/lib/valuation-cost-reconciliation'
import type { AiUser, DataQuality, DataQualityIssue } from './types'

type PortfolioStateRow = {
  active_dataset_id: string | null
  cloud_revision: number
  filename: string | null
  parser_version: string | null
  earliest_date: string | null
  latest_date: string | null
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

type ValuationSnapshotRow = {
  id: string
  revision: number
  valuation_date: string
  parser_version: string
  transaction_dataset_id: string
  transaction_revision: number
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

export type MarketRun = {
  id: string
  revision: number
  provider: string
  dataVersion: string
  transactionDatasetId: string
  transactionRevision: number
  earliestBarDate: string | null
  latestBarDate: string | null
  fetchedAt: string
  activatedAt: string | null
}

export type MarketObservation = {
  instrumentType: 'SECURITY' | 'FX' | 'BENCHMARK'
  ticker: string
  currency: string
  providerSymbol: string
  exchangeTimezone: string
  date: string
  rawClose: number
  adjustedClose: number | null
}

type MarketRunRow = {
  id: string
  revision: number
  provider: string
  data_version: string
  transaction_dataset_id: string
  transaction_revision: number
  earliest_bar_date: string | null
  latest_bar_date: string | null
  fetched_at: string
  activated_at: string | null
}

type MarketSeriesRow = {
  instrument_type: MarketObservation['instrumentType']
  ticker: string
  currency: string
  provider_symbol: string
  exchange_timezone: string
  bars_json: string
}

export type PortfolioState = {
  activeDatasetId: string | null
  cloudRevision: number
  filename: string | null
  parserVersion: string | null
  earliestDate: string | null
  latestDate: string | null
  activatedAt: string | null
}

export type ValuationBundle = {
  revision: number
  snapshot: ValuationSnapshotRow | null
  marks: NormalizedValuationMark[]
  transactions: StoredTransaction[]
  freshness: 'NO_SNAPSHOT' | 'CURRENT' | 'STALE'
  valuation: ReturnType<typeof buildPointInTimeValuation> | null
}

export type MarketBundle = {
  revision: number
  run: MarketRun | null
  freshness: 'NO_RUN' | 'CURRENT' | 'STALE'
  observations: MarketObservation[]
  marks: NormalizedValuationMark[]
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

function quality(status: DataQuality['status'], issues: DataQualityIssue[] = []): DataQuality {
  return { status, issues }
}

export class PortfolioReadSession {
  private statePromise?: Promise<PortfolioState>
  private transactionPromises = new Map<string, Promise<StoredTransaction[]>>()
  private valuationPromise?: Promise<ValuationBundle>
  private marketPromise?: Promise<MarketBundle>

  constructor(
    readonly db: D1Database,
    readonly user: AiUser,
  ) {}

  portfolioState(): Promise<PortfolioState> {
    this.statePromise ??= this.loadPortfolioState()
    return this.statePromise
  }

  async currentTransactions(): Promise<StoredTransaction[]> {
    const state = await this.portfolioState()
    if (!state.activeDatasetId) return []
    return this.transactionsForDataset(state.activeDatasetId)
  }

  transactionsForDataset(datasetId: string): Promise<StoredTransaction[]> {
    const existing = this.transactionPromises.get(datasetId)
    if (existing) return existing
    const request = this.loadTransactions(datasetId)
    this.transactionPromises.set(datasetId, request)
    return request
  }

  valuationBundle(): Promise<ValuationBundle> {
    this.valuationPromise ??= this.loadValuationBundle()
    return this.valuationPromise
  }

  marketBundle(): Promise<MarketBundle> {
    this.marketPromise ??= this.loadMarketBundle()
    return this.marketPromise
  }

  async analytics() {
    const [state, transactions, valuationBundle, marketBundle] = await Promise.all([
      this.portfolioState(),
      this.currentTransactions(),
      this.valuationBundle(),
      this.marketBundle(),
    ])
    const accounting = buildPortfolioAccounting(transactions)
    const cashLedger = buildCashFundingLedger(transactions)
    const fxCost = buildFxCostPool(transactions)

    const currentValuation = valuationBundle.freshness === 'CURRENT'
      ? valuationBundle.valuation
      : null
    const reconciliation = currentValuation
      ? reconcileValuationWithTwdCost(currentValuation, fxCost)
      : null
    const performance = buildCurrentPerformance({
      transactions,
      valuationDate: currentValuation ? valuationBundle.snapshot?.valuation_date ?? null : null,
      valuationComplete: currentValuation?.complete ?? false,
      terminalAssetsTwd: currentValuation?.totalAssetsTwd ?? null,
    })

    const historical = await this.historicalPerformance()
    return {
      state,
      transactions,
      accounting,
      cashLedger,
      fxCost,
      valuationBundle,
      marketBundle,
      currentValuation,
      reconciliation,
      performance,
      historical,
    }
  }

  async historicalPerformance(
    from?: string,
    to?: string,
  ): Promise<HistoricalPerformanceSeries | null> {
    const [valuationBundle, marketBundle] = await Promise.all([
      this.valuationBundle(),
      this.marketBundle(),
    ])
    if (!valuationBundle.snapshot) return null
    const marks = marketBundle.freshness === 'CURRENT' && marketBundle.marks.length > 0
      ? marketBundle.marks.map(toValuationMark)
      : valuationBundle.marks.map(toValuationMark)
    const dates = deriveHistoricalNavDates(
      marks,
      valuationBundle.snapshot.valuation_date,
      valuationBundle.transactions,
    ).filter((date) => (!from || date >= from) && (!to || date <= to))
    return buildHistoricalPerformanceSeries({
      transactions: valuationBundle.transactions,
      marks,
      dates,
      transactionRevision: valuationBundle.snapshot.transaction_revision,
      valuationRevision: valuationBundle.revision,
      valuationSnapshotId: valuationBundle.snapshot.id,
      valuationDate: valuationBundle.snapshot.valuation_date,
      totalReturnCoverage: 'PRICE_ONLY',
    })
  }

  private async loadPortfolioState(): Promise<PortfolioState> {
    const row = await this.db.prepare(
      `SELECT state.active_dataset_id, state.cloud_revision,
              dataset.filename, dataset.parser_version, dataset.earliest_date,
              dataset.latest_date, dataset.activated_at
         FROM portfolio_state state
         LEFT JOIN portfolio_datasets dataset
           ON dataset.id = state.active_dataset_id AND dataset.user_id = state.user_id
        WHERE state.user_id = ?`,
    ).bind(this.user.id).first<PortfolioStateRow>()
    return {
      activeDatasetId: row?.active_dataset_id ?? null,
      cloudRevision: row?.cloud_revision ?? 0,
      filename: row?.filename ?? null,
      parserVersion: row?.parser_version ?? null,
      earliestDate: row?.earliest_date ?? null,
      latestDate: row?.latest_date ?? null,
      activatedAt: row?.activated_at ?? null,
    }
  }

  private async loadTransactions(datasetId: string): Promise<StoredTransaction[]> {
    const rows = await this.db.prepare(
      `SELECT transaction_id, source_row_number, trade_date, transaction_type,
              ticker, currency, quantity, price, amount_foreign, fx_rate, fee,
              budget_waterline, budget_balance, note, row_hash
         FROM transactions
        WHERE dataset_id = ? AND user_id = ?
        ORDER BY trade_date, source_row_number`,
    ).bind(datasetId, this.user.id).all<TransactionRow>()
    return rows.results.map(transactionFromRow)
  }

  private async loadValuationBundle(): Promise<ValuationBundle> {
    const state = await this.portfolioState()
    const valuationState = await this.db.prepare(
      'SELECT active_snapshot_id, valuation_revision FROM valuation_state WHERE user_id = ?',
    ).bind(this.user.id).first<{ active_snapshot_id: string | null; valuation_revision: number }>()
    if (!valuationState?.active_snapshot_id) {
      return {
        revision: valuationState?.valuation_revision ?? 0,
        snapshot: null,
        marks: [],
        transactions: [],
        freshness: 'NO_SNAPSHOT',
        valuation: null,
      }
    }

    const snapshot = await this.db.prepare(
      `SELECT id, revision, valuation_date, parser_version,
              transaction_dataset_id, transaction_revision, activated_at
         FROM valuation_snapshots
        WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`,
    ).bind(valuationState.active_snapshot_id, this.user.id).first<ValuationSnapshotRow>()
    if (!snapshot) {
      return {
        revision: valuationState.valuation_revision,
        snapshot: null,
        marks: [],
        transactions: [],
        freshness: 'NO_SNAPSHOT',
        valuation: null,
      }
    }

    const marksResult = await this.db.prepare(
      `SELECT source_row_number, mark_date, mark_type, ticker,
              currency, value, source, row_hash
         FROM valuation_marks
        WHERE snapshot_id = ? AND user_id = ?
        ORDER BY mark_date, mark_type, ticker, currency, source_row_number`,
    ).bind(snapshot.id, this.user.id).all<MarkRow>()
    const marks = marksResult.results.map(markFromRow)
    const transactions = await this.transactionsForDataset(snapshot.transaction_dataset_id)
    const accounting = buildPortfolioAccounting(transactions)
    const cashLedger = buildCashFundingLedger(transactions)
    const valuation = buildPointInTimeValuation({
      valuationDate: snapshot.valuation_date,
      positions: accounting.positions,
      wallets: cashLedger.wallets,
      marks: marks.map(toValuationMark),
    })
    const freshness = snapshot.transaction_dataset_id === state.activeDatasetId
      && snapshot.transaction_revision === state.cloudRevision ? 'CURRENT' : 'STALE'
    return {
      revision: valuationState.valuation_revision,
      snapshot,
      marks,
      transactions,
      freshness,
      valuation,
    }
  }

  private async loadMarketBundle(): Promise<MarketBundle> {
    const state = await this.portfolioState()
    const marketState = await this.db.prepare(
      'SELECT active_run_id, market_revision FROM market_state WHERE user_id = ?',
    ).bind(this.user.id).first<{ active_run_id: string | null; market_revision: number }>()
    if (!marketState?.active_run_id) {
      return {
        revision: marketState?.market_revision ?? 0,
        run: null,
        freshness: 'NO_RUN',
        observations: [],
        marks: [],
      }
    }

    const row = await this.db.prepare(
      `SELECT id, revision, provider, data_version, transaction_dataset_id,
              transaction_revision, earliest_bar_date, latest_bar_date,
              fetched_at, activated_at
         FROM market_data_runs
        WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`,
    ).bind(marketState.active_run_id, this.user.id).first<MarketRunRow>()
    if (!row) throw new Error('ACTIVE market-data run metadata is missing')
    const run: MarketRun = {
      id: row.id,
      revision: row.revision,
      provider: row.provider,
      dataVersion: row.data_version,
      transactionDatasetId: row.transaction_dataset_id,
      transactionRevision: row.transaction_revision,
      earliestBarDate: row.earliest_bar_date,
      latestBarDate: row.latest_bar_date,
      fetchedAt: row.fetched_at,
      activatedAt: row.activated_at,
    }

    const seriesRows = await this.db.prepare(
      `SELECT instrument.instrument_type, instrument.ticker, instrument.currency,
              instrument.provider_symbol, instrument.exchange_timezone, instrument.bars_json
         FROM market_data_instruments instrument
         JOIN market_data_runs run ON run.id = instrument.run_id
        WHERE instrument.user_id = ? AND run.revision <= ?
          AND run.status IN ('ACTIVE', 'ARCHIVED')
        ORDER BY run.revision, instrument.instrument_type,
                 instrument.currency, instrument.ticker`,
    ).bind(this.user.id, marketState.market_revision).all<MarketSeriesRow>()

    const observationByKey = new Map<string, MarketObservation>()
    for (const series of seriesRows.results) {
      const bars = JSON.parse(series.bars_json) as Array<{
        date: string
        rawClose: number
        adjustedClose: number | null
      }>
      for (const bar of bars) {
        const key = `${series.instrument_type}\u0000${series.ticker}\u0000${series.currency}\u0000${bar.date}`
        observationByKey.set(key, {
          instrumentType: series.instrument_type,
          ticker: series.ticker,
          currency: series.currency,
          providerSymbol: series.provider_symbol,
          exchangeTimezone: series.exchange_timezone,
          date: bar.date,
          rawClose: bar.rawClose,
          adjustedClose: bar.adjustedClose,
        })
      }
    }
    const observations = [...observationByKey.values()].sort((a, b) =>
      a.date.localeCompare(b.date)
      || a.instrumentType.localeCompare(b.instrumentType)
      || a.currency.localeCompare(b.currency)
      || a.ticker.localeCompare(b.ticker))
    const marks: NormalizedValuationMark[] = observations.map((observation, index) => ({
      sourceRowNumber: index + 1,
      markDate: observation.date,
      markType: observation.instrumentType === 'FX' ? 'FX' : 'PRICE',
      ticker: observation.instrumentType === 'FX' ? '' : observation.ticker,
      currency: observation.currency,
      value: observation.rawClose,
      source: `${run.provider}:RAW_CLOSE`,
      rowHash: '0'.repeat(64),
    }))
    return {
      revision: marketState.market_revision,
      run,
      freshness: run.transactionDatasetId === state.activeDatasetId
        && run.transactionRevision === state.cloudRevision ? 'CURRENT' : 'STALE',
      observations,
      marks,
    }
  }
}

export function qualityFromIssues(
  freshness: 'CURRENT' | 'STALE' | 'NO_SNAPSHOT' | 'NO_RUN',
  issues: DataQualityIssue[],
): DataQuality {
  if (freshness === 'STALE') return quality('STALE', issues)
  if (freshness === 'NO_SNAPSHOT' || freshness === 'NO_RUN' || issues.length > 0) {
    return quality('INCOMPLETE', issues)
  }
  return quality('COMPLETE')
}
