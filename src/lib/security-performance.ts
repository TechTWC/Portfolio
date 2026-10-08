import type { NormalizedTransaction } from './contracts'

const EPSILON = 1e-9

export const SECURITY_CASH_FLOW_CALCULATION_VERSION = 'estimated-security-cash-flow-v0.1'

export type SecurityCashFlowIssueCode =
  | 'MISSING_VALUATION'
  | 'INCOMPLETE_VALUATION'
  | 'INVALID_VALUATION_DATE'
  | 'TRANSACTION_AFTER_VALUATION_DATE'
  | 'MISSING_SECURITY_FLOW_FX'
  | 'INVALID_SECURITY_PROCEEDS'

export type SecurityCashFlowIssue = {
  code: SecurityCashFlowIssueCode
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

export type SecurityCashFlowSummaryInput = {
  transactions: NormalizedTransaction[]
  valuationDate: string | null
  positionValuationComplete: boolean
  terminalPositionValueTwd: number | null
}

export type SecurityCashFlowSummary = {
  valuationDate: string | null
  complete: boolean
  estimated: true
  calculationVersion: typeof SECURITY_CASH_FLOW_CALCULATION_VERSION
  grossPurchasesTwd: number
  grossSaleProceedsTwd: number
  netSecurityCapitalDeployedTwd: number
  terminalPositionValueTwd: number | null
  estimatedGainTwd: number | null
  securityMultiple: number | null
  securityCashFlows: SecurityCashFlow[]
  issues: SecurityCashFlowIssue[]
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

export function buildSecurityCashFlowSummary(
  input: SecurityCashFlowSummaryInput,
): SecurityCashFlowSummary {
  const issues: SecurityCashFlowIssue[] = []
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
        message: `有 ${laterRows.length} 筆證券交易晚於估值日；目前不能安全建立同一時點的證券投入摘要`,
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

    const amountNative = row.amountForeign > 0
      ? row.amountForeign
      : Math.abs(row.quantity) * row.price
    const purchase = row.quantity > 0
    const netAmountNative = purchase ? amountNative + row.fee : amountNative - row.fee
    if (!Number.isFinite(netAmountNative) || (purchase ? netAmountNative <= 0 : netAmountNative < -EPSILON)) {
      issues.push({
        code: 'INVALID_SECURITY_PROCEEDS',
        severity: 'BLOCKING',
        message: `第 ${row.sourceRowNumber} 列證券交易扣除費用後金額無效`,
        sourceRowNumbers: [row.sourceRowNumber],
      })
      continue
    }

    if (!purchase && netAmountNative <= EPSILON) continue

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
  const summaryInputsComplete = issues.length === 0
  const estimatedGainTwd = terminalPositionValueTwd === null || !summaryInputsComplete
    ? null
    : clean(terminalPositionValueTwd + grossSaleProceedsTwd - grossPurchasesTwd)
  const securityMultiple = terminalPositionValueTwd === null
    || grossPurchasesTwd <= EPSILON
    || !summaryInputsComplete
    ? null
    : (terminalPositionValueTwd + grossSaleProceedsTwd) / grossPurchasesTwd

  return {
    valuationDate,
    complete: summaryInputsComplete,
    estimated: true,
    calculationVersion: SECURITY_CASH_FLOW_CALCULATION_VERSION,
    grossPurchasesTwd,
    grossSaleProceedsTwd,
    netSecurityCapitalDeployedTwd,
    terminalPositionValueTwd,
    estimatedGainTwd,
    securityMultiple,
    securityCashFlows: events,
    issues,
    blockingIssueCount: issues.length,
  }
}
