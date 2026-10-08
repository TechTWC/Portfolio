import type {
  MarketBar,
  MarketInstrument,
  MarketInstrumentFetchResult,
} from '../src/lib/market-data-contracts'

const MAX_STALE_DAYS = 10
const MAX_BOUNDED_HISTORY_TAIL_GAP_DAYS = 14
const MAX_BARS_PER_INSTRUMENT = 10_000

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        currency?: string
        exchangeTimezoneName?: string
        currentTradingPeriod?: { regular?: { start?: number; end?: number } }
      }
      timestamp?: number[]
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>
        adjclose?: Array<{ adjclose?: Array<number | null> }>
      }
    }> | null
    error?: { code?: string; description?: string } | null
  }
}

export type YahooStrategyHistory = {
  ticker: string
  currency: string
  quoteUnit: string
  quoteScaleToCurrency: number
  exchangeTimezone: string
  bars: MarketBar[]
  latestCloseDate: string
  latestRawClose: number
}

function strategyQuoteCurrency(unit: string): { currency: string; scale: number } {
  // Yahoo quotes UK equities in pence/GBX rather than whole GBP.
  if (unit === 'GBp' || unit === 'GBX') return { currency: 'GBP', scale: 0.01 }
  if (!/^[A-Z]{3}$/.test(unit)) throw new Error(`UNSUPPORTED_YAHOO_QUOTE_UNIT: ${unit}`)
  return { currency: unit, scale: 1 }
}

function addDays(date: string, count: number): string {
  const parsed = new Date(date + 'T00:00:00Z')
  parsed.setUTCDate(parsed.getUTCDate() + count)
  return parsed.toISOString().slice(0, 10)
}

function unixSecondsAtUtcStart(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)
}

function calendarDateInTimezone(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp * 1000))
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function daysBetween(left: string, right: string): number {
  return Math.floor((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000)
}

function isCurrentSessionIncomplete(
  timestamp: number,
  regular: { start?: number; end?: number } | undefined,
  nowSeconds: number,
): boolean {
  if (!regular?.start || !regular.end || nowSeconds >= regular.end) return false
  return timestamp >= regular.start && timestamp < regular.end
}

export function yahooSymbolForFx(currency: string): string {
  const normalized = currency.trim().toUpperCase()
  if (normalized === 'USD') return 'TWD=X'
  return `${normalized}TWD=X`
}

async function fetchYahooChartHistory(
  providerSymbol: string,
  startDate: string,
  fetcher: typeof fetch,
  now: Date,
  endDate?: string,
): Promise<{
  providerCurrency: string
  rawQuoteUnit: string
  exchangeTimezone: string
  bars: MarketBar[]
  latestCloseDate: string
  latestRawClose: number
}> {
  const period1 = unixSecondsAtUtcStart(startDate)
  const livePeriod2 = Math.floor(now.getTime() / 1000) + 86_400
  const period2 = endDate
    ? Math.min(livePeriod2, unixSecondsAtUtcStart(addDays(endDate, 1)))
    : livePeriod2
  if (!Number.isFinite(period1) || !Number.isFinite(period2) || period1 >= period2) {
    throw new Error('INVALID_YAHOO_HISTORY_PERIOD')
  }
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}`)
  url.searchParams.set('period1', String(period1))
  url.searchParams.set('period2', String(period2))
  url.searchParams.set('interval', '1d')
  url.searchParams.set('events', 'history')
  url.searchParams.set('includeAdjustedClose', 'true')

  const response = await fetcher(url.toString(), {
    headers: { accept: 'application/json', 'user-agent': 'PortfolioAnalyzer/1.0' },
  })
  if (!response.ok) throw new Error(`${providerSymbol} 行情來源回應 HTTP ${response.status}`)

  const payload = await response.json() as YahooChartResponse
  const providerError = payload.chart?.error
  if (providerError) {
    throw new Error(`${providerSymbol} 行情來源錯誤：${providerError.description ?? providerError.code ?? 'UNKNOWN'}`)
  }
  const result = payload.chart?.result?.[0]
  if (!result) throw new Error(`${providerSymbol} 沒有行情資料`)

  const rawQuoteUnit = result.meta?.currency?.trim() ?? ''
  const providerCurrency = rawQuoteUnit.toUpperCase()

  const timestamps = result.timestamp ?? []
  const closes = result.indicators?.quote?.[0]?.close ?? []
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? []
  const exchangeTimezone = result.meta?.exchangeTimezoneName || 'UTC'
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const regular = result.meta?.currentTradingPeriod?.regular
  const byDate = new Map<string, MarketBar>()

  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index]
    const rawClose = closes[index]
    if (!Number.isFinite(timestamp) || !Number.isFinite(rawClose) || Number(rawClose) <= 0) continue
    if (isCurrentSessionIncomplete(timestamp, regular, nowSeconds)) continue
    const date = calendarDateInTimezone(timestamp, exchangeTimezone)
    if (date < startDate || (endDate && date > endDate)) continue
    const adjustedClose = adjusted[index]
    byDate.set(date, {
      date,
      rawClose: Number(rawClose),
      adjustedClose: Number.isFinite(adjustedClose) && Number(adjustedClose) > 0
        ? Number(adjustedClose)
        : null,
    })
  }

  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  if (bars.length > MAX_BARS_PER_INSTRUMENT) {
    throw new Error(`${providerSymbol} 回傳 ${bars.length} 筆，超過安全上限 ${MAX_BARS_PER_INSTRUMENT} 筆`)
  }
  const latest = bars.at(-1)
  if (!latest) throw new Error(`${providerSymbol} 沒有有效的已完成收盤價`)
  const today = now.toISOString().slice(0, 10)
  const coverageEnd = endDate && endDate < today ? endDate : today
  const maximumLag = endDate ? MAX_BOUNDED_HISTORY_TAIL_GAP_DAYS : MAX_STALE_DAYS
  if (daysBetween(latest.date, coverageEnd) > maximumLag) {
    throw new Error(`${providerSymbol} 最新收盤日 ${latest.date} 已超過 ${maximumLag} 天`)
  }

  return {
    providerCurrency,
    rawQuoteUnit,
    exchangeTimezone,
    bars,
    latestCloseDate: latest.date,
    latestRawClose: latest.rawClose,
  }
}

export async function fetchYahooDailyHistory(
  instrument: MarketInstrument,
  fetcher: typeof fetch,
  now = new Date(),
  endDate?: string,
): Promise<MarketInstrumentFetchResult> {
  const result = await fetchYahooChartHistory(instrument.providerSymbol, instrument.startDate, fetcher, now, endDate)
  if (instrument.instrumentType !== 'FX' && (!result.providerCurrency || result.providerCurrency !== instrument.currency)) {
    throw new Error(`${instrument.providerSymbol} 幣別為 ${result.providerCurrency || 'UNKNOWN'}，預期為 ${instrument.currency}`)
  }
  return {
    ...instrument,
    exchangeTimezone: result.exchangeTimezone,
    bars: result.bars,
    latestCloseDate: result.latestCloseDate,
    latestRawClose: result.latestRawClose,
  }
}

export async function fetchYahooStrategyHistory(
  ticker: string,
  startDate: string,
  fetcher: typeof fetch,
  now = new Date(),
  endDate?: string,
): Promise<YahooStrategyHistory> {
  const normalizedTicker = ticker.trim().toUpperCase()
  if (!normalizedTicker) throw new Error('策略標的代號不得為空')
  const result = await fetchYahooChartHistory(normalizedTicker, startDate, fetcher, now, endDate)
  if (!result.rawQuoteUnit) throw new Error(`${normalizedTicker} 行情來源未提供幣別`)
  const quote = strategyQuoteCurrency(result.rawQuoteUnit)
  return {
    ticker: normalizedTicker,
    currency: quote.currency,
    quoteUnit: result.rawQuoteUnit,
    quoteScaleToCurrency: quote.scale,
    exchangeTimezone: result.exchangeTimezone,
    bars: result.bars,
    latestCloseDate: result.latestCloseDate,
    latestRawClose: result.latestRawClose,
  }
}
