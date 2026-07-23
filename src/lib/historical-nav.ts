import { buildPortfolioAccounting } from './accounting'
import { buildCashFundingLedger } from './cash-ledger'
import type { NormalizedTransaction } from './contracts'
import { buildFxCostPool } from './fx-cost-pool'
import { buildPointInTimeValuation, type PointInTimeValuation, type ValuationMark } from './valuation'

const EPSILON = 1e-9

export type HistoricalNavIssueDomain =
  | 'SERIES'
  | 'SECURITY_ACCOUNTING'
  | 'CASH_FX_FUNDING'
  | 'FX_COST_BASIS'
  | 'VALUATION'
  | 'EXTERNAL_FLOW'

export type HistoricalNavIssue = {
  domain: HistoricalNavIssueDomain
  code: string
  message: string
  sourceRowNumbers: number[]
}

export type HistoricalNavPoint = {
  asOfDate: string
  complete: boolean
  transactionCount: number
  contributionTwdOnDate: number
  withdrawalTwdOnDate: number
  positionValueTwd: number
  cashValueTwd: number
  knownTotalAssetsTwd: number
  totalAssetsTwd: number | null
  latestPriceDateUsed: string | null
  latestFxDateUsed: string | null
  valuation: PointInTimeValuation
  issues: HistoricalNavIssue[]
  blockingIssueCount: number
}

export type HistoricalNavSeries = {
  requestedDates: string[]
  normalizedDates: string[]
  points: HistoricalNavPoint[]
  issues: HistoricalNavIssue[]
  completePointCount: number
  incompletePointCount: number
}

export type HistoricalNavInput = {
  transactions: NormalizedTransaction[]
  marks: ValuationMark[]
  dates: string[]
}

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function externalFlowAmountTwd(row: NormalizedTransaction): number | null {
  const rate = row.currency === 'TWD' ? 1 : row.fxRate
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null
  return row.amountForeign * rate
}

function latestDate(values: Array<string | null>): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest
    if (!latest || value > latest) return value
    return latest
  }, null)
}

export function buildAsOfNavPoint(
  transactions: NormalizedTransaction[],
  marks: ValuationMark[],
  asOfDate: string,
): HistoricalNavPoint {
  const filteredTransactions = [...transactions]
    .filter((row) => row.tradeDate <= asOfDate)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber)

  const accounting = buildPortfolioAccounting(filteredTransactions)
  const cashLedger = buildCashFundingLedger(filteredTransactions)
  const fxCost = buildFxCostPool(filteredTransactions)
  const valuation = buildPointInTimeValuation({
    valuationDate: asOfDate,
    positions: accounting.positions,
    wallets: cashLedger.wallets,
    marks,
  })

  const issues: HistoricalNavIssue[] = []

  for (const issue of accounting.issues.filter((item) => item.severity === 'BLOCKING')) {
    issues.push({
      domain: 'SECURITY_ACCOUNTING',
      code: issue.code,
      message: issue.message,
      sourceRowNumbers: [issue.sourceRowNumber],
    })
  }

  for (const issue of cashLedger.issues) {
    issues.push({
      domain: 'CASH_FX_FUNDING',
      code: issue.code,
      message: issue.message,
      sourceRowNumbers: [issue.sourceRowNumber],
    })
  }

  const existingRowCodes = new Set(issues.map((issue) => `${issue.sourceRowNumbers[0] ?? 0}\u0000${issue.code}`))
  for (const issue of fxCost.issues) {
    const key = `${issue.sourceRowNumber}\u0000${issue.code}`
    if (existingRowCodes.has(key)) continue
    issues.push({
      domain: 'FX_COST_BASIS',
      code: issue.code,
      message: issue.message,
      sourceRowNumbers: [issue.sourceRowNumber],
    })
  }

  for (const issue of valuation.issues) {
    issues.push({
      domain: 'VALUATION',
      code: issue.code,
      message: issue.message,
      sourceRowNumbers: issue.sourceRowNumbers,
    })
  }

  let contributionTwdOnDate = 0
  let withdrawalTwdOnDate = 0
  for (const row of filteredTransactions.filter((item) => item.tradeDate === asOfDate)) {
    if (row.transactionType !== 'CASH_IN' && row.transactionType !== 'CASH_OUT') continue
    const amountTwd = externalFlowAmountTwd(row)
    if (amountTwd === null) {
      issues.push({
        domain: 'EXTERNAL_FLOW',
        code: 'MISSING_EXTERNAL_FLOW_FX',
        message: `第 ${row.sourceRowNumber} 列 ${row.currency} ${row.transactionType} 缺少實際歷史匯率`,
        sourceRowNumbers: [row.sourceRowNumber],
      })
      continue
    }
    if (row.transactionType === 'CASH_IN') contributionTwdOnDate += amountTwd
    else withdrawalTwdOnDate += amountTwd
  }

  contributionTwdOnDate = clean(contributionTwdOnDate)
  withdrawalTwdOnDate = clean(withdrawalTwdOnDate)
  const latestPriceDateUsed = latestDate(valuation.positions.map((position) => position.priceDate))
  const latestFxDateUsed = latestDate([
    ...valuation.positions.map((position) => position.fxDate),
    ...valuation.cash.map((cash) => cash.fxDate),
  ])
  const blockingIssueCount = issues.length
  const complete = blockingIssueCount === 0 && valuation.complete

  return {
    asOfDate,
    complete,
    transactionCount: filteredTransactions.length,
    contributionTwdOnDate,
    withdrawalTwdOnDate,
    positionValueTwd: clean(valuation.knownPositionValueTwd),
    cashValueTwd: clean(valuation.knownCashValueTwd),
    knownTotalAssetsTwd: clean(valuation.knownTotalAssetsTwd),
    totalAssetsTwd: complete ? clean(valuation.knownTotalAssetsTwd) : null,
    latestPriceDateUsed,
    latestFxDateUsed,
    valuation,
    issues: issues.sort((a, b) =>
      a.domain.localeCompare(b.domain)
      || a.code.localeCompare(b.code)
      || (a.sourceRowNumbers[0] ?? 0) - (b.sourceRowNumbers[0] ?? 0),
    ),
    blockingIssueCount,
  }
}

export function buildHistoricalNavSeries(input: HistoricalNavInput): HistoricalNavSeries {
  const requestedDates = [...input.dates]
  const seriesIssues: HistoricalNavIssue[] = []
  const validDates = new Set<string>()

  for (const rawDate of requestedDates) {
    const date = rawDate.trim()
    if (!isIsoDate(date)) {
      seriesIssues.push({
        domain: 'SERIES',
        code: 'INVALID_AS_OF_DATE',
        message: `歷史 NAV 日期不是有效的 YYYY-MM-DD：${rawDate}`,
        sourceRowNumbers: [],
      })
      continue
    }
    validDates.add(date)
  }

  const normalizedDates = [...validDates].sort()
  const points = normalizedDates.map((date) => buildAsOfNavPoint(input.transactions, input.marks, date))

  return {
    requestedDates,
    normalizedDates,
    points,
    issues: seriesIssues,
    completePointCount: points.filter((point) => point.complete).length,
    incompletePointCount: points.filter((point) => !point.complete).length,
  }
}
