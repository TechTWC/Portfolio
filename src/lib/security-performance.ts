import type { NormalizedTransaction } from './contracts'
import { findXirrRoots } from './performance'

const EPSILON = 1e-9

export const SECURITY_INVESTMENT_CALCULATION_VERSION = 'estimated-security-investment-xirr-v0.1'

export type SecurityPerformanceIssueCode =
  | 'MISSING_VALUATION'
  | 'INCOMPLETE_VALUATION'
  | 'INVALID_VALUATION_DATE'
  | 'TRANSACTION_AFTER_VALUATION_DATE'
  | 'MISSING_SECURITY_FLOW_FX'
  | 'INVALID_SECURITY_PROCEEDS'
  | 'NO_SECURITY_PURCHASE'
  | 'NO_POSITIVE_CASH_FLOW'
  | 'ZERO_TIME_SPAN'
  | 'XIRR_NOT_FOUND'
  | 'MULTIPLE_XIRR_ROOTS'

export type SecurityPerformanceIssue = {
  code: SecurityPerformanceIssueCode
  severity: 'BLOCKING'
  message: string
  sourceRowNumbers: number[]
}

export type SecurityCashFlowKind = 'PURCHASE' | 'SALE' | 'TERMINAL_POSITION_VALUE'

export type SecurityCashFlow = {
  date: string
  kind: SecurityCashFlowKind
  amountTwd: number
  signedAmountTwd: number
  sourceRowNumbers: number[]
}

export type SecurityInvestmentPerformanceInput = {
  transactions: NormalizedTransaction[]
  valuationDate: string | null
  positionValuationComplete: boolean
  terminalPositionValueTwd: number | null
}

export type SecurityInvestmentPerformance = {
  valuationDate: string | null
  complete: boolean
  estimated: true
  calculationVersion: typeof SECURITY_INVESTMENT_CALCULATION_VERSION
  grossPurchasesTwd: number
  grossSaleProceedsTwd: number
  netSecurityCapitalDeployedTwd: number
  terminalPositionValueTwd: number | null
  estimatedGainTwd: number | null
  securityMultiple: number | null
  xirr: number | null
  securityCashFlows: SecurityCashFlow[]
  issues: SecurityPerformanceIssue[]
  blockingIssueCount: number
}

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function aggregateFlows(events: SecurityCashFlow[]): Array<{ date: string; amount: number }> {
  const byDate = new Map<string, number>()
  for (const event of events) {
    byDate.set(event.date, (byDate.get(event.date) ?? 0) + event.signedAmountTwd)
  }
  return [...byDate.entries()]
    .map(([date, amount]) => ({ date, amount: clean(amount) }))
    .filter((flow) => Math.abs(flow.amount) > EPSILON)
    .sort((a, b) => a.date.localeCompare(b.date))
}

export function buildSecurityInvestmentPerformance(
  input: SecurityInvestmentPerformanceInput,
): SecurityInvestmentPerformance {
  const issues: SecurityPerformanceIssue[] = []
  const events: SecurityCashFlow[] = []
  const valuationDate = input.valuationDate

  if (!valuationDate) {
    issues.push({
      code: 'MISSING_VALUATION',
      severity: 'BLOCKING',
      message: '尚未建立 ACTIVE 估值 Snapshot，無法計入期末持倉市值',
      sourceRowNumbers: [],
    })
  } else if (!isIsoDate(valuationDate)) {
    issues.push({
      code: 'INVALID_VALUATION_DATE',
      severity: 'BLOCKING',
      message: '估值日不是有效的 YYYY-MM-DD',
      sourceRowNumbers: [],
    })
  }

  if (
    !input.positionValuationComplete
    || input.terminalPositionValueTwd === null
    || !Number.isFinite(input.terminalPositionValueTwd)
    || input.terminalPositionValueTwd < 0
  ) {
    issues.push({
      code: 'INCOMPLETE_VALUATION',
      severity: 'BLOCKING',
      message: 'ACTIVE 持倉估值不完整，不能把已知部分持倉當成完整期末市值',
      sourceRowNumbers: [],
    })
  }

  if (valuationDate && isIsoDate(valuationDate)) {
    const laterRows = input.transactions.filter((row) =>
      row.transactionType === 'SECURITY' && row.tradeDate > valuationDate,
    )
    if (laterRows.length > 0) {
      issues.push({
        code: 'TRANSACTION_AFTER_VALUATION_DATE',
        severity: 'BLOCKING',
        message: `有 ${laterRows.length} 筆交易晚於估值日；目前不能安全建立同一時點的推估報酬`,
        sourceRowNumbers: laterRows.map((row) => row.sourceRowNumber).sort((a, b) => a - b),
      })
    }
  }

  const sortedTransactions = [...input.transactions].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber,
  )
  for (const row of sortedTransactions) {
    if (row.transactionType !== 'SECURITY') continue
    if (valuationDate && isIsoDate(valuationDate) && row.tradeDate > valuationDate) continue

    const rate = row.currency === 'TWD' ? 1 : row.fxRate
    if (rate === null || !Number.isFinite(rate) || rate <= 0) {
      issues.push({
        code: 'MISSING_SECURITY_FLOW_FX',
        severity: 'BLOCKING',
        message: `第 ${row.sourceRowNumber} 列 ${row.currency} 證券交易缺少可用的交易日匯率`,
        sourceRowNumbers: [row.sourceRowNumber],
      })
      continue
    }

    const amountNative = row.amountForeign > 0
      ? row.amountForeign
      : Math.abs(row.quantity) * row.price
    const purchase = row.quantity > 0
    const netAmountNative = purchase ? amountNative + row.fee : amountNative - row.fee
    if (!Number.isFinite(netAmountNative) || netAmountNative <= 0) {
      issues.push({
        code: 'INVALID_SECURITY_PROCEEDS',
        severity: 'BLOCKING',
        message: `第 ${row.sourceRowNumber} 列證券交易扣除費用後金額無效`,
        sourceRowNumbers: [row.sourceRowNumber],
      })
      continue
    }

    const amountTwd = clean(netAmountNative * rate)
    events.push({
      date: row.tradeDate,
      kind: purchase ? 'PURCHASE' : 'SALE',
      amountTwd,
      signedAmountTwd: purchase ? -amountTwd : amountTwd,
      sourceRowNumbers: [row.sourceRowNumber],
    })
  }

  if (
    valuationDate
    && isIsoDate(valuationDate)
    && input.positionValuationComplete
    && input.terminalPositionValueTwd !== null
    && Number.isFinite(input.terminalPositionValueTwd)
    && input.terminalPositionValueTwd >= 0
  ) {
    events.push({
      date: valuationDate,
      kind: 'TERMINAL_POSITION_VALUE',
      amountTwd: input.terminalPositionValueTwd,
      signedAmountTwd: input.terminalPositionValueTwd,
      sourceRowNumbers: [],
    })
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
  const grossPurchasesTwd = clean(events
    .filter((event) => event.kind === 'PURCHASE')
    .reduce((total, event) => total + event.amountTwd, 0))
  const grossSaleProceedsTwd = clean(events
    .filter((event) => event.kind === 'SALE')
    .reduce((total, event) => total + event.amountTwd, 0))
  const terminalPositionValueTwd = input.positionValuationComplete
    ? input.terminalPositionValueTwd
    : null
  const netSecurityCapitalDeployedTwd = clean(grossPurchasesTwd - grossSaleProceedsTwd)
  const estimatedGainTwd = terminalPositionValueTwd === null
    ? null
    : clean(terminalPositionValueTwd + grossSaleProceedsTwd - grossPurchasesTwd)
  const securityMultiple = terminalPositionValueTwd === null || grossPurchasesTwd <= EPSILON
    ? null
    : (terminalPositionValueTwd + grossSaleProceedsTwd) / grossPurchasesTwd

  if (grossPurchasesTwd <= EPSILON) {
    issues.push({
      code: 'NO_SECURITY_PURCHASE',
      severity: 'BLOCKING',
      message: '沒有可辨識的證券買進，推估 XIRR 無法定義',
      sourceRowNumbers: [],
    })
  }

  const flows = aggregateFlows(events)
  if (!flows.some((flow) => flow.amount > EPSILON)) {
    issues.push({
      code: 'NO_POSITIVE_CASH_FLOW',
      severity: 'BLOCKING',
      message: '沒有賣出收入或期末持倉市值等正現金流，推估 XIRR 無法定義',
      sourceRowNumbers: [],
    })
  }

  if (flows.length >= 2 && flows[0].date === flows[flows.length - 1].date) {
    issues.push({
      code: 'ZERO_TIME_SPAN',
      severity: 'BLOCKING',
      message: '所有證券現金流都在同一天，無法年化為推估 XIRR',
      sourceRowNumbers: [],
    })
  }

  let xirr: number | null = null
  if (issues.length === 0) {
    const roots = findXirrRoots(flows)
    if (roots.length === 0) {
      issues.push({
        code: 'XIRR_NOT_FOUND',
        severity: 'BLOCKING',
        message: '在允許的利率區間內找不到推估 XIRR 解',
        sourceRowNumbers: [],
      })
    } else if (roots.length > 1) {
      issues.push({
        code: 'MULTIPLE_XIRR_ROOTS',
        severity: 'BLOCKING',
        message: `證券現金流存在 ${roots.length} 個 XIRR 解，系統不會任選其中一個`,
        sourceRowNumbers: [],
      })
    } else {
      xirr = roots[0]
    }
  }

  return {
    valuationDate,
    complete: issues.length === 0 && xirr !== null,
    estimated: true,
    calculationVersion: SECURITY_INVESTMENT_CALCULATION_VERSION,
    grossPurchasesTwd,
    grossSaleProceedsTwd,
    netSecurityCapitalDeployedTwd,
    terminalPositionValueTwd,
    estimatedGainTwd,
    securityMultiple,
    xirr,
    securityCashFlows: events,
    issues,
    blockingIssueCount: issues.length,
  }
}
