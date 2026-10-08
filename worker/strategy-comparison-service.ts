import {
  STRATEGY_COMPARISON_VERSION,
  type StrategyComparisonRequest,
  type StrategyComparisonResponse,
} from '../src/lib/strategy-comparison-contracts'
import {
  buildStrategyComparisonCore,
  type StrategyPriceSeries,
} from '../src/lib/strategy-comparison'
import type { MarketInstrument } from '../src/lib/market-data-contracts'
import {
  fetchYahooDailyHistory,
  fetchYahooStrategyHistory,
  yahooSymbolForFx,
} from './market-data-provider'
import { getPortfolioState, getTransactionsForDataset } from './repository'

const FX_LOOKBACK_DAYS = 10
const MAX_HISTORY_BOUNDARY_GAP_DAYS = 14

type User = { id: string; email: string }
type StrategyPortfolioState = { activeDatasetId: string | null; cloudRevision: number }

export async function admitStrategyComparison(
  rateLimiter: RateLimit | undefined,
  userId: string,
): Promise<void> {
  if (!rateLimiter) return
  const admission = await rateLimiter.limit({
    key: `strategy-comparison:${userId}`,
  })
  if (!admission.success) throw new Error('STRATEGY_RATE_LIMITED')
}

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

export function adjustedStrategyPriceTwd(
  adjustedClose: number,
  quoteScaleToCurrency: number,
  fxRate: number,
): number {
  const value = adjustedClose * quoteScaleToCurrency * fxRate
  if (!Number.isFinite(value) || value <= 0) throw new Error('INVALID_STRATEGY_TWD_PRICE')
  return value
}

function daysBetween(left: string, right: string): number {
  return Math.round((Date.parse(right + 'T00:00:00Z') - Date.parse(left + 'T00:00:00Z')) / 86400000)
}

async function strategyMarketDataVersion(
  histories: Awaited<ReturnType<typeof fetchYahooStrategyHistory>>[],
  fxEntries: ReadonlyArray<readonly [string, Awaited<ReturnType<typeof fetchYahooDailyHistory>>]>,
): Promise<string> {
  const canonical = JSON.stringify({
    securities: histories.map((history) => ({
      ticker: history.ticker,
      quoteUnit: history.quoteUnit,
      quoteScaleToCurrency: history.quoteScaleToCurrency,
      bars: history.bars,
    })),
    fx: [...fxEntries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, history]) => ({ currency, bars: history.bars })),
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `YAHOO_FINANCE_CHART_ADJUSTED_CLOSE_PROXY:v0.1:${hex}`
}

function latestFxOnOrBefore(
  bars: Array<{ date: string; rawClose: number }>,
  date: string,
): number | null {
  let left = 0
  let right = bars.length
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (bars[middle].date <= date) left = middle + 1
    else right = middle
  }
  const bar = bars[left - 1]
  if (!bar || !Number.isFinite(bar.rawClose) || bar.rawClose <= 0) return null
  const ageDays = (Date.parse(date + 'T00:00:00Z') - Date.parse(bar.date + 'T00:00:00Z')) / 86400000
  return ageDays >= 0 && ageDays <= FX_LOOKBACK_DAYS ? bar.rawClose : null
}

export async function runStrategyComparison(
  db: D1Database,
  user: User,
  request: StrategyComparisonRequest,
  options: {
    fetcher?: typeof fetch
    now?: Date
    rateLimiter?: RateLimit
    portfolioState?: StrategyPortfolioState
  } = {},
): Promise<StrategyComparisonResponse> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? new Date()
  await admitStrategyComparison(options.rateLimiter, user.id)
  const portfolio = options.portfolioState ?? await getPortfolioState(db, user.id)
  if (!portfolio.activeDatasetId || portfolio.cloudRevision <= 0) {
    throw new Error('NO_ACTIVE_DATASET')
  }
  // Bind the simulation to the exact ACTIVE Dataset observed at the start.
  // getActiveTransactions() would race a concurrent dataset activation.
  const transactions = await getTransactionsForDataset(db, user.id, portfolio.activeDatasetId)
  const allocations = request.allocations.map((item) => ({
    ticker: item.ticker.trim().toUpperCase(),
    weight: item.weight,
  }))

  const histories = await Promise.all(allocations.map((allocation) =>
    fetchYahooStrategyHistory(allocation.ticker, request.startDate, fetcher, now, request.endDate),
  ))
  const foreignCurrencies = [...new Set(histories
    .map((history) => history.currency)
    .filter((currency) => currency !== 'TWD'))]
  const fxEntries = await Promise.all(foreignCurrencies.map(async (currency) => {
    const instrument: MarketInstrument = {
      instrumentType: 'FX',
      ticker: '',
      currency,
      providerSymbol: yahooSymbolForFx(currency),
      startDate: subtractDays(request.startDate, FX_LOOKBACK_DAYS),
    }
    return [currency, await fetchYahooDailyHistory(
      instrument,
      fetcher,
      now,
      request.endDate,
      { rejectMissingTimestampedClose: true },
    )] as const
  }))
  const fxByCurrency = new Map(fxEntries)
  const marketDataVersion = await strategyMarketDataVersion(histories, fxEntries)

  const coverageEnd = request.endDate < now.toISOString().slice(0, 10)
    ? request.endDate : now.toISOString().slice(0, 10)
  const priceSeries: StrategyPriceSeries[] = histories.map((history) => {
    const fxBars = history.currency === 'TWD' ? null : fxByCurrency.get(history.currency)?.bars ?? null
    // A missing price or historical FX is incomplete data, not a non-trading day.
    // Silently dropping it would move scheduled investments and bias returns.
    const points = history.bars
      .filter((bar) => bar.date >= request.startDate && bar.date <= request.endDate)
      .map((bar) => {
        if (bar.adjustedClose === null || !Number.isFinite(bar.adjustedClose) || bar.adjustedClose <= 0) {
          throw new Error(`MISSING_STRATEGY_ADJUSTED_CLOSE: ${history.ticker} ${bar.date}`)
        }
        const fxRate = history.currency === 'TWD' ? 1 : latestFxOnOrBefore(fxBars ?? [], bar.date)
        if (fxRate === null) {
          throw new Error(`MISSING_STRATEGY_HISTORICAL_FX: ${history.ticker} ${bar.date}`)
        }
        return {
          date: bar.date,
          totalReturnPriceTwd: adjustedStrategyPriceTwd(
            bar.adjustedClose, history.quoteScaleToCurrency, fxRate,
          ),
        }
      })
    if (points.length === 0) {
      throw new Error(`${history.ticker} 在比較期間沒有可用的 adjusted-close TWD proxy`)
    }
    if (daysBetween(request.startDate, points[0].date) > MAX_HISTORY_BOUNDARY_GAP_DAYS
        || daysBetween(points.at(-1)!.date, coverageEnd) > MAX_HISTORY_BOUNDARY_GAP_DAYS) {
      throw new Error(`TRUNCATED_STRATEGY_HISTORY: ${history.ticker}`)
    }
    for (let index = 1; index < points.length; index += 1) {
      if (daysBetween(points[index - 1].date, points[index].date) > MAX_HISTORY_BOUNDARY_GAP_DAYS) {
        throw new Error(`GAPPED_STRATEGY_HISTORY: ${history.ticker}`)
      }
    }
    return { ticker: history.ticker, points }
  })

  const core = buildStrategyComparisonCore({
    request: { ...request, allocations },
    priceSeries,
    transactions,
  })
  if (!core.dca.startDate || !core.dca.endDate
      || daysBetween(request.startDate, core.dca.startDate) > MAX_HISTORY_BOUNDARY_GAP_DAYS
      || daysBetween(core.dca.endDate, coverageEnd) > MAX_HISTORY_BOUNDARY_GAP_DAYS) {
    throw new Error('TRUNCATED_COMMON_STRATEGY_HISTORY')
  }
  for (let index = 1; index < core.dca.curve.length; index += 1) {
    if (daysBetween(core.dca.curve[index - 1].date, core.dca.curve[index].date)
        > MAX_HISTORY_BOUNDARY_GAP_DAYS) {
      throw new Error('GAPPED_COMMON_STRATEGY_HISTORY')
    }
  }
  const strategies = {
    dca: core.dca,
    lumpSum: core.lumpSum,
    transactionReplay: core.transactionReplay,
  }
  const status = Object.values(strategies).some((result) => result.status === 'INCOMPLETE')
    ? 'INCOMPLETE' as const
    : 'ESTIMATED' as const
  const latestPortfolio = await getPortfolioState(db, user.id)
  if (latestPortfolio.cloudRevision !== portfolio.cloudRevision
      || latestPortfolio.activeDatasetId !== portfolio.activeDatasetId) {
    throw new Error('TRANSACTION_VERSION_CONFLICT')
  }

  return {
    calculationVersion: STRATEGY_COMPARISON_VERSION,
    status,
    priceBasis: 'YAHOO_ADJUSTED_CLOSE_TWD_PROXY',
    assumptions: [
      '策略績效使用 Yahoo adjusted close 作為股息與公司行動的總報酬代理；不等同正式 Corporate Action Ledger。',
      '海外報價若使用可辨識的子單位（例如 GBp）先正規化為整幣，才與歷史外匯匯率換算。',
      '模擬允許小數單位，且 v0.1 不計手續費、交易稅、滑價與融資成本。',
      'DCA 每月以開始日的日號排程，遇非共同交易日順延至下一個所有標的皆有價格的交易日。',
      'Lump Sum 使用與本次 DCA 實際執行次數相同的總投入本金，於第一個共同交易日一次投入。',
      'Transaction Replay 將實際 SECURITY 買進視為投入、賣出淨款視為收回；它是交易路徑模擬，不是標準外部入出金 PME。',
    ],
    marketSource: 'YAHOO_FINANCE_CHART',
    marketDataVersion,
    transactionRevision: portfolio.cloudRevision,
    allocations,
    instruments: histories.map((history) => ({
      ticker: history.ticker,
      currency: history.currency,
      quoteUnit: history.quoteUnit,
      quoteScaleToCurrency: history.quoteScaleToCurrency,
      exchangeTimezone: history.exchangeTimezone,
      firstDate: history.bars[0]?.date ?? request.startDate,
      lastDate: history.bars.at(-1)?.date ?? request.endDate,
    })),
    dcaMonthlyAmountTwd: request.dcaMonthlyAmountTwd,
    lumpSumPrincipalTwd: core.lumpSumPrincipalTwd,
    strategies,
  }
}
