import type { StrategyComparisonRequest } from '../../src/lib/strategy-comparison-contracts'
import { strategyComparisonRequestSchema } from '../../src/lib/strategy-comparison-contracts'
import { DataPlatformError, type QueryFilters } from './types'

// The six public MCP tools accept scalar filters, not arbitrary nested JSON.
// Encode an allocation as TICKER:PERCENT, e.g. 0050.TW:50,2330.TW:50.
export const STRATEGY_QUERY_FILTERS = [
  'start_date', 'end_date', 'dca_monthly_amount_twd', 'allocations',
] as const

export function parseStrategyQueryFilters(filters: QueryFilters): StrategyComparisonRequest {
  const startDate = filters.start_date
  const endDate = filters.end_date
  const amount = filters.dca_monthly_amount_twd
  const text = filters.allocations
  if (typeof startDate !== 'string' || typeof endDate !== 'string'
      || (typeof amount !== 'number' && typeof amount !== 'string')
      || typeof text !== 'string' || text.length > 300) {
    throw new DataPlatformError(
      'INVALID_STRATEGY_FILTER',
      '必填：start_date、end_date、dca_monthly_amount_twd、allocations（例如 0050.TW:50,2330.TW:50）',
    )
  }
  const allocationStrings = text.split(',').map((item) => item.trim())
  if (allocationStrings.length < 1 || allocationStrings.length > 5) {
    throw new DataPlatformError('INVALID_STRATEGY_FILTER', '策略配置必須包含 1–5 個標的')
  }
  const allocations = allocationStrings.map((entry) => {
    const parts = entry.split(':')
    const ticker = parts[0]?.trim().toUpperCase() ?? ''
    const percent = Number(parts[1])
    if (parts.length !== 2 || !/^[A-Z0-9^._-]{1,40}$/.test(ticker)
        || !Number.isFinite(percent) || percent <= 0 || percent > 100) {
      throw new DataPlatformError('INVALID_STRATEGY_FILTER', 'allocations 格式應為 TICKER:PERCENT（各權重須大於 0）')
    }
    return { ticker, weight: percent / 100 }
  })
  const parsed = strategyComparisonRequestSchema.safeParse({
    startDate, endDate, dcaMonthlyAmountTwd: Number(amount), allocations,
  })
  if (!parsed.success) {
    throw new DataPlatformError(
      'INVALID_STRATEGY_FILTER',
      parsed.error.issues[0]?.message ?? '策略比較參數不符合合約',
    )
  }
  return parsed.data
}
