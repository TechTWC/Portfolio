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
import { getActiveTransactions, getPortfolioState } from './repository'

const FX_LOOKBACK_DAYS = 10

type User = { id: string; email: string }

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
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
  return bar && Number.isFinite(bar.rawClose) && bar.rawClose > 0 ? bar.rawClose : null
}

export async function runStrategyComparison(
  db: D1Database,
  user: User,
  request: StrategyComparisonRequest,
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<StrategyComparisonResponse> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? new Date()
  const portfolio = await getPortfolioState(db, user.id)
  if (!portfolio.activeDatasetId || portfolio.cloudRevision <= 0) {
    throw new Error('NO_ACTIVE_DATASET')
  }
  const transactions = await getActiveTransactions(db, user.id)
  const allocations = request.allocations.map((item) => ({
    ticker: item.ticker.trim().toUpperCase(),
    weight: item.weight,
  }))

  const histories = await Promise.all(allocations.map((allocation) =>
    fetchYahooStrategyHistory(allocation.ticker, request.startDate, fetcher, now),
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
    return [currency, await fetchYahooDailyHistory(instrument, fetcher, now)] as const
  }))
  const fxByCurrency = new Map(fxEntries)

  const priceSeries: StrategyPriceSeries[] = histories.map((history) => {
    const fxBars = history.currency === 'TWD' ? null : fxByCurrency.get(history.currency)?.bars ?? null
    const points = history.bars
      .filter((bar) => bar.date >= request.startDate && bar.date <= request.endDate)
      .flatMap((bar) => {
        if (bar.adjustedClose === null || !Number.isFinite(bar.adjustedClose) || bar.adjustedClose <= 0) return []
        const fxRate = history.currency === 'TWD' ? 1 : latestFxOnOrBefore(fxBars ?? [], bar.date)
        if (fxRate === null) return []
        return [{
          date: bar.date,
          totalReturnPriceTwd: bar.adjustedClose * fxRate,
        }]
      })
    if (points.length === 0) {
      throw new Error(`${history.ticker} 在比較期間沒有可用的 adjusted-close TWD proxy`)
    }
    return { ticker: history.ticker, points }
  })

  const core = buildStrategyComparisonCore({
    request: { ...request, allocations },
    priceSeries,
    transactions,
  })
  const strategies = {
    dca: core.dca,
    lumpSum: core.lumpSum,
    transactionReplay: core.transactionReplay,
  }
  const status = Object.values(strategies).some((result) => result.status === 'INCOMPLETE')
    ? 'INCOMPLETE' as const
    : 'ESTIMATED' as const

  return {
    calculationVersion: STRATEGY_COMPARISON_VERSION,
    status,
    priceBasis: 'YAHOO_ADJUSTED_CLOSE_TWD_PROXY',
    assumptions: [
      '策略績效使用 Yahoo adjusted close 作為股息與公司行動的總報酬代理；不等同正式 Corporate Action Ledger。',
      '模擬允許小數單位，且 v0.1 不計手續費、交易稅、滑價與融資成本。',
      'DCA 每月以開始日的日號排程，遇非共同交易日順延至下一個所有標的皆有價格的交易日。',
      'Lump Sum 使用與本次 DCA 實際執行次數相同的總投入本金，於第一個共同交易日一次投入。',
      'Transaction Replay 將實際 SECURITY 買進視為投入、賣出淨款視為收回；它是交易路徑模擬，不是標準外部入出金 PME。',
    ],
    marketSource: 'YAHOO_FINANCE_CHART',
    transactionRevision: portfolio.cloudRevision,
    allocations,
    instruments: histories.map((history) => ({
      ticker: history.ticker,
      currency: history.currency,
      exchangeTimezone: history.exchangeTimezone,
      firstDate: history.bars[0]?.date ?? request.startDate,
      lastDate: history.bars.at(-1)?.date ?? request.endDate,
    })),
    dcaMonthlyAmountTwd: request.dcaMonthlyAmountTwd,
    lumpSumPrincipalTwd: core.lumpSumPrincipalTwd,
    strategies,
  }
}
