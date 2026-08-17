import { buildPortfolioAccounting } from '../src/lib/accounting'
import { buildCashFundingLedger } from '../src/lib/cash-ledger'
import { sha256Hex } from '../src/lib/hash'
import {
  MARKET_DATA_PROVIDER,
  MARKET_DATA_VERSION,
  type MarketDataRefreshRequest,
  type MarketDataRefreshResponse,
  type MarketInstrument,
  type MarketInstrumentFetchResult,
} from '../src/lib/market-data-contracts'
import { buildPointInTimeValuation } from '../src/lib/valuation'
import { compareValuationMarks } from '../src/lib/valuation-diff'
import type { NormalizedValuationMark, ValuationSnapshotUpload } from '../src/lib/valuation-contracts'
import { transactionBindingMatches } from '../src/lib/valuation-lineage'
import {
  activateMarketRun,
  createPendingMarketRun,
  getMarketDataBootstrap,
  latestMarketDates,
  type MarketObservationInsert,
} from './market-data-repository'
import { fetchYahooDailyHistory, yahooSymbolForFx } from './market-data-provider'
import { getPortfolioState, getTransactionsForDataset } from './repository'
import {
  activateValuationSnapshot,
  currentValuationRevision,
  getActiveValuationMarks,
  getValuationBootstrap,
} from './valuation-repository'

const BENCHMARK_TICKER = 'SPY'
const FETCH_CONCURRENCY = 4
const OVERLAP_DAYS = 10
const MAX_INSTRUMENTS = 25
const MAX_OBSERVATIONS_PER_REFRESH = 50_000

type User = { id: string; email: string }

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function laterDate(left: string, right: string): string {
  return left > right ? left : right
}

function instrumentKey(instrument: Pick<MarketInstrument, 'instrumentType' | 'ticker' | 'currency'>): string {
  return `${instrument.instrumentType}\u0000${instrument.ticker}\u0000${instrument.currency}`
}

export function deriveMarketInstruments(
  transactions: Awaited<ReturnType<typeof getTransactionsForDataset>>,
  existingLatestDates = new Map<string, string>(),
): MarketInstrument[] {
  const securityStarts = new Map<string, { currency: string; startDate: string }>()
  const currencyStarts = new Map<string, string>()
  let portfolioStart = ''

  for (const row of transactions) {
    if (!portfolioStart || row.tradeDate < portfolioStart) portfolioStart = row.tradeDate
    if (row.currency !== 'TWD') {
      const current = currencyStarts.get(row.currency)
      if (!current || row.tradeDate < current) currencyStarts.set(row.currency, row.tradeDate)
    }
    if (row.transactionType !== 'SECURITY') continue
    const existing = securityStarts.get(row.ticker)
    if (existing && existing.currency !== row.currency) {
      throw new Error(`${row.ticker} 同時出現 ${existing.currency} 與 ${row.currency}，無法安全抓價`)
    }
    if (!existing || row.tradeDate < existing.startDate) {
      securityStarts.set(row.ticker, { currency: row.currency, startDate: row.tradeDate })
    }
  }
  if (!portfolioStart || securityStarts.size === 0) throw new Error('目前沒有可抓取行情的證券交易')

  const instruments: MarketInstrument[] = [...securityStarts.entries()].map(([ticker, value]) => ({
    instrumentType: 'SECURITY',
    ticker,
    currency: value.currency,
    providerSymbol: ticker,
    startDate: value.startDate,
  }))

  if (!securityStarts.has(BENCHMARK_TICKER)) {
    instruments.push({
      instrumentType: 'BENCHMARK',
      ticker: BENCHMARK_TICKER,
      currency: 'USD',
      providerSymbol: BENCHMARK_TICKER,
      startDate: portfolioStart,
    })
    const currentUsd = currencyStarts.get('USD')
    if (!currentUsd || portfolioStart < currentUsd) currencyStarts.set('USD', portfolioStart)
  }

  for (const [currency, startDate] of currencyStarts) {
    instruments.push({
      instrumentType: 'FX',
      ticker: '',
      currency,
      providerSymbol: yahooSymbolForFx(currency),
      startDate,
    })
  }

  return instruments
    .map((instrument) => {
      const latest = existingLatestDates.get(instrumentKey(instrument))
      return latest
        ? { ...instrument, startDate: laterDate(instrument.startDate, subtractDays(latest, OVERLAP_DAYS)) }
        : instrument
    })
    .sort((a, b) => instrumentKey(a).localeCompare(instrumentKey(b)))
}

async function fetchInBatches(
  instruments: MarketInstrument[],
  fetcher: typeof fetch,
  now: Date,
): Promise<MarketInstrumentFetchResult[]> {
  const output: MarketInstrumentFetchResult[] = []
  for (let offset = 0; offset < instruments.length; offset += FETCH_CONCURRENCY) {
    const chunk = instruments.slice(offset, offset + FETCH_CONCURRENCY)
    output.push(...await Promise.all(chunk.map((instrument) =>
      fetchYahooDailyHistory(instrument, fetcher, now),
    )))
  }
  return output
}

async function observationFor(
  result: MarketInstrumentFetchResult,
  bar: MarketInstrumentFetchResult['bars'][number],
): Promise<MarketObservationInsert> {
  const hashInput = [
    MARKET_DATA_PROVIDER,
    'RAW_CLOSE',
    result.instrumentType,
    result.ticker,
    result.currency,
    bar.date,
    bar.rawClose,
    bar.adjustedClose ?? '',
  ].join('|')
  return {
    instrumentType: result.instrumentType,
    ticker: result.ticker,
    currency: result.currency,
    providerSymbol: result.providerSymbol,
    exchangeTimezone: result.exchangeTimezone,
    date: bar.date,
    rawClose: bar.rawClose,
    adjustedClose: bar.adjustedClose,
    rowHash: await sha256Hex(hashInput),
  }
}

async function buildValuationPayload(
  request: MarketDataRefreshRequest,
  results: MarketInstrumentFetchResult[],
  fetchedAt: string,
): Promise<ValuationSnapshotUpload> {
  const valuationResults = results.filter((result) => result.instrumentType !== 'BENCHMARK')
  const marks: NormalizedValuationMark[] = await Promise.all(valuationResults.map(async (result, index) => ({
    sourceRowNumber: index + 1,
    markDate: result.latestCloseDate,
    markType: result.instrumentType === 'FX' ? 'FX' as const : 'PRICE' as const,
    ticker: result.instrumentType === 'FX' ? '' : result.ticker,
    currency: result.currency,
    value: result.latestRawClose,
    source: `${MARKET_DATA_PROVIDER}:RAW_CLOSE`,
    rowHash: await sha256Hex([
      MARKET_DATA_PROVIDER,
      'RAW_CLOSE',
      result.instrumentType,
      result.ticker,
      result.currency,
      result.latestCloseDate,
      result.latestRawClose,
    ].join('|')),
  })))
  const valuationDate = marks.reduce((latest, mark) => mark.markDate > latest ? mark.markDate : latest, '')
  const fileHash = await sha256Hex(marks.map((mark) => mark.rowHash).sort().join('|'))
  return {
    baseRevision: request.baseValuationRevision,
    transactionDatasetId: request.transactionDatasetId,
    transactionRevision: request.transactionRevision,
    valuationDate,
    filename: `automatic-market-data-${fetchedAt.slice(0, 10)}.json`,
    fileHash,
    parserVersion: MARKET_DATA_VERSION,
    sourceRowCount: marks.length,
    rejectedRowCount: 0,
    marks,
  }
}

export async function refreshMarketData(
  db: D1Database,
  user: User,
  request: MarketDataRefreshRequest,
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<MarketDataRefreshResponse> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? new Date()
  const fetchedAt = now.toISOString()
  const portfolio = await getPortfolioState(db, user.id)
  if (!transactionBindingMatches({
    transactionDatasetId: request.transactionDatasetId,
    transactionRevision: request.transactionRevision,
  }, portfolio)) {
    throw new Error('TRANSACTION_VERSION_CONFLICT')
  }
  const valuationRevision = await currentValuationRevision(db, user.id)
  if (valuationRevision !== request.baseValuationRevision) throw new Error('VALUATION_VERSION_CONFLICT')

  const transactions = await getTransactionsForDataset(db, user.id, request.transactionDatasetId)
  const existingDates = await latestMarketDates(db, user.id)
  const instruments = deriveMarketInstruments(transactions, existingDates)
  if (instruments.length > MAX_INSTRUMENTS) {
    throw new Error(`自動行情一次最多支援 ${MAX_INSTRUMENTS} 個證券、匯率與基準，目前需要 ${instruments.length} 個`)
  }
  const results = await fetchInBatches(instruments, fetcher, now)
  const valuationPayload = await buildValuationPayload(request, results, fetchedAt)
  const currentValuationMarks = await getActiveValuationMarks(db, user.id)
  const currentValuation = await getValuationBootstrap(db, user)
  const valuationUnchanged = currentValuation.freshness === 'CURRENT'
    && compareValuationMarks(currentValuationMarks, valuationPayload.marks).unchanged

  const accounting = buildPortfolioAccounting(transactions)
  const cash = buildCashFundingLedger(transactions)
  const candidate = buildPointInTimeValuation({
    valuationDate: valuationPayload.valuationDate,
    positions: accounting.positions,
    wallets: cash.wallets,
    marks: valuationPayload.marks,
  })
  if (!candidate.complete) {
    throw new Error(`VALUATION_INCOMPLETE:${candidate.issues.map((issue) => issue.code).join(',')}`)
  }

  const observations = (await Promise.all(results.flatMap((result) =>
    result.bars.map((bar) => observationFor(result, bar)),
  ))).sort((a, b) => a.date.localeCompare(b.date) || instrumentKey(a).localeCompare(instrumentKey(b)))
  if (observations.length > MAX_OBSERVATIONS_PER_REFRESH) {
    throw new Error(`本次行情共有 ${observations.length} 筆，超過安全上限 ${MAX_OBSERVATIONS_PER_REFRESH} 筆`)
  }
  const run = await createPendingMarketRun(db, user, {
    transactionDatasetId: request.transactionDatasetId,
    transactionRevision: request.transactionRevision,
    dataVersion: MARKET_DATA_VERSION,
    benchmarkTicker: BENCHMARK_TICKER,
    fetchedAt,
    results,
    observations,
  })
  await activateMarketRun(db, user.id, run, {
    transactionDatasetId: request.transactionDatasetId,
    transactionRevision: request.transactionRevision,
  })
  if (!valuationUnchanged) {
    await activateValuationSnapshot(db, user, valuationPayload, {
      duplicateCount: 0,
      futureMarkCount: 0,
      totalAssetsTwd: candidate.totalAssetsTwd,
      source: MARKET_DATA_PROVIDER,
      marketRunId: run.id,
      marketRevision: run.revision,
    })
  }

  return {
    market: await getMarketDataBootstrap(db, user, false),
    valuation: await getValuationBootstrap(db, user),
  }
}
