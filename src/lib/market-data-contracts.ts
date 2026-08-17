import { z } from 'zod'
import type { NormalizedValuationMark, ValuationBootstrapResponse } from './valuation-contracts'

export const MARKET_DATA_PROVIDER = 'YAHOO_FINANCE_CHART' as const
export const MARKET_DATA_VERSION = 'market-data-v1.0.0'

export const marketDataRefreshRequestSchema = z.object({
  baseValuationRevision: z.number().int().nonnegative(),
  transactionDatasetId: z.string().uuid(),
  transactionRevision: z.number().int().positive(),
})

export type MarketDataRefreshRequest = z.infer<typeof marketDataRefreshRequestSchema>

export type MarketInstrumentType = 'SECURITY' | 'FX' | 'BENCHMARK'

export type MarketInstrument = {
  instrumentType: MarketInstrumentType
  ticker: string
  currency: string
  providerSymbol: string
  startDate: string
}

export type MarketBar = {
  date: string
  rawClose: number
  adjustedClose: number | null
}

export type MarketInstrumentFetchResult = MarketInstrument & {
  exchangeTimezone: string
  bars: MarketBar[]
  latestCloseDate: string
  latestRawClose: number
}

export type MarketDataRunSummary = {
  id: string
  revision: number
  status: 'PENDING' | 'ACTIVE' | 'ARCHIVED' | 'FAILED'
  provider: typeof MARKET_DATA_PROVIDER
  dataVersion: string
  transactionDatasetId: string
  transactionRevision: number
  benchmarkTicker: string
  instrumentCount: number
  barCount: number
  earliestBarDate: string | null
  latestBarDate: string | null
  fetchedAt: string
  activatedAt: string | null
}

export type MarketDataInstrumentSummary = {
  instrumentType: MarketInstrumentType
  ticker: string
  currency: string
  providerSymbol: string
  exchangeTimezone: string
  barCount: number
  earliestBarDate: string
  latestBarDate: string
  latestRawClose: number
}

export type MarketDataBootstrapResponse = {
  marketRevision: number
  currentTransactionDatasetId: string | null
  currentTransactionRevision: number
  freshness: 'NO_RUN' | 'CURRENT' | 'STALE'
  activeRun: MarketDataRunSummary | null
  instruments: MarketDataInstrumentSummary[]
  marks: NormalizedValuationMark[]
}

export type MarketDataRefreshResponse = {
  market: MarketDataBootstrapResponse
  valuation: ValuationBootstrapResponse
}
