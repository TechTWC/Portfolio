import { z } from 'zod'

export const STRATEGY_COMPARISON_VERSION = 'strategy-comparison-v0.1' as const

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const strategyAllocationSchema = z.object({
  ticker: z.string().trim().min(1).max(40),
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
