import { z } from 'zod'

export const STRATEGY_COMPARISON_VERSION = 'strategy-comparison-v0.1' as const

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const parsed = new Date(date + 'T00:00:00Z')
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
  }, { message: '日期不存在，請使用有效的 YYYY-MM-DD' })

export const strategyAllocationSchema = z.object({
  ticker: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9^._-]+$/, '標的代號只能使用 Yahoo 允許的代碼字元'),
  weight: z.number().finite().positive().max(1),
})

export const strategyComparisonRequestSchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  dcaMonthlyAmountTwd: z.number().finite().positive().max(1_000_000_000),
  allocations: z.array(strategyAllocationSchema).min(1).max(5),
}).superRefine((value, ctx) => {
  if (value.startDate > value.endDate) {
    ctx.addIssue({ code: 'custom', path: ['endDate'], message: '結束日不得早於開始日' })
  }
  const startUtc = Date.parse(value.startDate + 'T00:00:00Z')
  const endUtc = Date.parse(value.endDate + 'T00:00:00Z')
  if (Number.isFinite(startUtc) && Number.isFinite(endUtc)
      && endUtc - startUtc > 30 * 366 * 86400000) {
    ctx.addIssue({ code: 'custom', path: ['startDate'], message: '比較期間上限為 30 年' })
  }
  const tickers = value.allocations.map((item) => item.ticker.trim().toUpperCase())
  if (new Set(tickers).size !== tickers.length) {
    ctx.addIssue({ code: 'custom', path: ['allocations'], message: '投資組合不可重複設定相同標的' })
  }
  const totalWeight = value.allocations.reduce((sum, item) => sum + item.weight, 0)
  if (Math.abs(totalWeight - 1) > 1e-6) {
    ctx.addIssue({ code: 'custom', path: ['allocations'], message: '投資組合權重合計必須為 100%' })
  }
})

export type StrategyComparisonRequest = z.infer<typeof strategyComparisonRequestSchema>
export type StrategyAllocation = z.infer<typeof strategyAllocationSchema>

export type StrategyMode = 'DCA' | 'LUMP_SUM' | 'TRANSACTION_REPLAY'
export type StrategyStatus = 'ESTIMATED' | 'INCOMPLETE'

export type StrategyExecution = {
  requestedDate: string
  executionDate: string
  kind: 'CONTRIBUTION' | 'WITHDRAWAL'
  amountTwd: number
  sourceRowNumbers: number[]
}

export type StrategyCurvePoint = {
  date: string
  totalAssetsTwd: number
  cumulativeTwr: number | null
  growthIndex: number | null
  drawdown: number | null
}

export type StrategyIssue = {
  code: string
  severity: 'BLOCKING' | 'WARNING'
  message: string
  sourceRowNumbers: number[]
}

export type StrategySimulationResult = {
  mode: StrategyMode
  status: StrategyStatus
  startDate: string | null
  endDate: string | null
  grossContributionsTwd: number
  grossWithdrawalsTwd: number
  terminalValueTwd: number | null
  estimatedGainTwd: number | null
  moneyMultiple: number | null
  xirr: number | null
  cumulativeTwr: number | null
  annualizedTwr: number | null
  maximumDrawdown: number | null
  recoveryDate: string | null
  executionCount: number
  executions: StrategyExecution[]
  curve: StrategyCurvePoint[]
  issues: StrategyIssue[]
}

export type StrategyMarketInstrument = {
  ticker: string
  currency: string
  quoteUnit: string
  quoteScaleToCurrency: number
  exchangeTimezone: string
  firstDate: string
  lastDate: string
}

export type StrategyComparisonResponse = {
  calculationVersion: typeof STRATEGY_COMPARISON_VERSION
  status: StrategyStatus
  priceBasis: 'YAHOO_ADJUSTED_CLOSE_TWD_PROXY'
  assumptions: string[]
  marketSource: string
  marketDataVersion: string
  transactionRevision: number
  allocations: StrategyAllocation[]
  instruments: StrategyMarketInstrument[]
  dcaMonthlyAmountTwd: number
  lumpSumPrincipalTwd: number
  strategies: {
    dca: StrategySimulationResult
    lumpSum: StrategySimulationResult
    transactionReplay: StrategySimulationResult
  }
}
