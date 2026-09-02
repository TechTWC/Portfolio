import { buildPortfolioAccounting } from '../../src/lib/accounting'
import { buildCashFundingLedger } from '../../src/lib/cash-ledger'
import type { StoredTransaction } from '../../src/lib/contracts'
import { buildFxCostPool } from '../../src/lib/fx-cost-pool'
import { deriveHistoricalNavDates } from '../../src/lib/historical-nav-schedule'
import { buildCurrentPerformance } from '../../src/lib/performance'
import { buildSecurityInvestmentPerformance } from '../../src/lib/security-performance'
import {
  buildHistoricalPerformanceSeries,
  type HistoricalPerformanceSeries,
} from '../../src/lib/time-weighted-performance'
import type { NormalizedValuationMark } from '../../src/lib/valuation-contracts'
import { toValuationMark } from '../../src/lib/valuation-contracts'
import { buildPointInTimeValuation } from '../../src/lib/valuation'
import { reconcileValuationWithTwdCost } from '../../src/lib/valuation-cost-reconciliation'
import { determineDateFreshness, staleMarketDataMessage } from '../../src/lib/market-data-freshness'
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
  freshnessIssues: DataQualityIssue[]
  valuation: ReturnType<typeof buildPointInTimeValuation> | null
}

export type ValuationMetadata = Pick<ValuationBundle, 'revision' | 'snapshot' | 'freshness' | 'freshnessIssues'>

export type MarketBundle = {
  revision: number
  run: MarketRun | null
  freshness: 'NO_RUN' | 'CURRENT' | 'STALE'
  freshnessIssues: DataQualityIssue[]
  observations: MarketObservation[]
  marks: NormalizedValuationMark[]
}

export type MarketMetadata = Pick<MarketBundle, 'revision' | 'run' | 'freshness' | 'freshnessIssues'>

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
  private valuationMetadataPromise?: Promise<ValuationMetadata>
  private valuationPromise?: Promise<ValuationBundle>
  private marketMetadataPromise?: Promise<MarketMetadata>
  private marketPromise?: Promise<MarketBundle>

  constructor(
    readonly db: D1Database,
    readonly user: AiUser,
    readonly now = new Date(),
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

  valuationMetadata(): Promise<ValuationMetadata> {
    this.valuationMetadataPromise ??= this.loadValuationMetadata()
    return this.valuationMetadataPromise
  }

  marketBundle(): Promise<MarketBundle> {
    this.marketPromise ??= this.loadMarketBundle()
    return this.marketPromise
  }

  marketMetadata(): Promise<MarketMetadata> {
    this.marketMetadataPromise ??= this.loadMarketMetadata()
    return this.marketMetadataPromise
  }

  async currentAnalytics() {
    const [state, transactions, valuationBundle] = await Promise.all([
      this.portfolioState(),
      this.currentTransactions(),
      this.valuationBundle(),
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
    const securityPerformance = buildSecurityInvestmentPerformance({
      transactions,
      valuationDate: currentValuation ? valuationBundle.snapshot?.valuation_date ?? null : null,
      valuationComplete: currentValuation?.complete ?? false,
      terminalPositionValueTwd: currentValuation?.knownPositionValueTwd ?? null,
    })

    return {
      state,
      transactions,
      accounting,
      cashLedger,
      fxCost,
      valuationBundle,
      currentValuation,
      reconciliation,
      performance,
      securityPerformance,
    }
  }

  async analytics() {
    const [current, marketBundle, historical] = await Promise.all([
      this.currentAnalytics(),
      this.marketBundle(),
      this.historicalPerformance(),
    ])
    return {
      ...current,
      marketBundle,
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

  private async loadValuationMetadata(): Promise<ValuationMetadata> {
    const state = await this.portfolioState()
    const valuationState = await this.db.prepare(
      'SELECT active_snapshot_id, valuation_revision FROM valuation_state WHERE user_id = ?',
    ).bind(this.user.id).first<{ active_snapshot_id: string | null; valuation_revision: number }>()
    if (!valuationState?.active_snapshot_id) {
      return {
        revision: valuationState?.valuation_revision ?? 0,
        snapshot: null,
        freshness: 'NO_SNAPSHOT',
        freshnessIssues: [],
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
        freshness: 'NO_SNAPSHOT',
        freshnessIssues: [],
      }
    }

    const transactionCurrent = snapshot.transaction_dataset_id === state.activeDatasetId
      && snapshot.transaction_revision === state.cloudRevision
    const dateFreshness = determineDateFreshness(snapshot.valuation_date, this.now)
    const freshnessIssues: DataQualityIssue[] = []
    if (!transactionCurrent) {
      freshnessIssues.push({
        type: 'TRANSACTION_VERSION_STALE',
        message: `估值綁定交易 v${snapshot.transaction_revision}，目前交易為 v${state.cloudRevision}`,
      })
    } else if (dateFreshness.stale) {
      freshnessIssues.push({
        type: 'VALUATION_DATE_STALE',
        message: staleMarketDataMessage(snapshot.valuation_date, dateFreshness.ageDays),
        date: snapshot.valuation_date,
      })
    }
    return {
      revision: valuationState.valuation_revision,
      snapshot,
      freshness: transactionCurrent && !dateFreshness.stale ? 'CURRENT' : 'STALE',
      freshnessIssues,
    }
  }

  private async loadValuationBundle(): Promise<ValuationBundle> {
    const metadata = await this.valuationMetadata()
    const snapshot = metadata.snapshot
    if (!snapshot) {
      return {
        ...metadata,
        marks: [],
        transactions: [],
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
    return {
      ...metadata,
      snapshot,
      marks,
      transactions,
      valuation,
    }
  }

  private async loadMarketMetadata(): Promise<MarketMetadata> {
    const state = await this.portfolioState()
    const marketState = await this.db.prepare(
      'SELECT active_run_id, market_revision FROM market_state WHERE user_id = ?',
    ).bind(this.user.id).first<{ active_run_id: string | null; market_revision: number }>()
    if (!marketState?.active_run_id) {
      return {
        revision: marketState?.market_revision ?? 0,
        run: null,
        freshness: 'NO_RUN',
        freshnessIssues: [],
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

    const transactionCurrent = run.transactionDatasetId === state.activeDatasetId
      && run.transactionRevision === state.cloudRevision
    const dateFreshness = determineDateFreshness(run.latestBarDate, this.now)
    const freshnessIssues: DataQualityIssue[] = []
    if (!transactionCurrent) {
      freshnessIssues.push({
        type: 'TRANSACTION_VERSION_STALE',
        message: `行情綁定交易 v${run.transactionRevision}，目前交易為 v${state.cloudRevision}`,
      })
    } else if (dateFreshness.stale) {
      freshnessIssues.push({
        type: 'MARKET_DATA_DATE_STALE',
        message: staleMarketDataMessage(run.latestBarDate, dateFreshness.ageDays),
        date: run.latestBarDate ?? undefined,
      })
    }
    return {
      revision: marketState.market_revision,
      run,
      freshness: transactionCurrent && !dateFreshness.stale ? 'CURRENT' : 'STALE',
      freshnessIssues,
    }
  }

  private async loadMarketBundle(): Promise<MarketBundle> {
    const metadata = await this.marketMetadata()
    const run = metadata.run
    if (!run) {
      return {
        ...metadata,
        observations: [],
        marks: [],
      }
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
    ).bind(this.user.id, metadata.revision).all<MarketSeriesRow>()

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
      ...metadata,
      run,
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
