import type {
  MarketBar,
  MarketInstrument,
  MarketInstrumentFetchResult,
} from '../src/lib/market-data-contracts'

const MAX_STALE_DAYS = 10
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

export async function fetchYahooDailyHistory(
  instrument: MarketInstrument,
  fetcher: typeof fetch,
  now = new Date(),
): Promise<MarketInstrumentFetchResult> {
  const period1 = unixSecondsAtUtcStart(instrument.startDate)
  const period2 = Math.floor(now.getTime() / 1000) + 86_400
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(instrument.providerSymbol)}`)
  url.searchParams.set('period1', String(period1))
  url.searchParams.set('period2', String(period2))
  url.searchParams.set('interval', '1d')
  url.searchParams.set('events', 'history')
  url.searchParams.set('includeAdjustedClose', 'true')

  const response = await fetcher(url.toString(), {
    headers: { accept: 'application/json', 'user-agent': 'PortfolioAnalyzer/1.0' },
  })
  if (!response.ok) {
    throw new Error(`${instrument.providerSymbol} 行情來源回應 HTTP ${response.status}`)
  }

  const payload = await response.json() as YahooChartResponse
  const providerError = payload.chart?.error
  if (providerError) {
    throw new Error(`${instrument.providerSymbol} 行情來源錯誤：${providerError.description ?? providerError.code ?? 'UNKNOWN'}`)
  }
  const result = payload.chart?.result?.[0]
  if (!result) throw new Error(`${instrument.providerSymbol} 沒有行情資料`)

  const providerCurrency = result.meta?.currency?.trim().toUpperCase()
  if (instrument.instrumentType !== 'FX' && providerCurrency && providerCurrency !== instrument.currency) {
    throw new Error(`${instrument.providerSymbol} 幣別為 ${providerCurrency}，預期為 ${instrument.currency}`)
  }

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
    if (date < instrument.startDate) continue
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
    throw new Error(`${instrument.providerSymbol} 回傳 ${bars.length} 筆，超過安全上限 ${MAX_BARS_PER_INSTRUMENT} 筆`)
  }
  const latest = bars.at(-1)
  if (!latest) throw new Error(`${instrument.providerSymbol} 沒有有效的已完成收盤價`)
  const today = now.toISOString().slice(0, 10)
  if (daysBetween(latest.date, today) > MAX_STALE_DAYS) {
    throw new Error(`${instrument.providerSymbol} 最新收盤日 ${latest.date} 已超過 ${MAX_STALE_DAYS} 天`)
  }

  return {
    ...instrument,
    exchangeTimezone,
    bars,
    latestCloseDate: latest.date,
    latestRawClose: latest.rawClose,
  }
}
