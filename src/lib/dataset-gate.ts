import { buildPortfolioAccounting } from './accounting'
import { buildCashFundingLedger } from './cash-ledger'
import type { NormalizedTransaction } from './contracts'

export type ActivationBlockingIssue = {
  domain: 'SECURITY_ACCOUNTING' | 'CASH_FX_FUNDING'
  code: string
  sourceRowNumber: number
  tradeDate: string
  currency: string
  message: string
  required?: number
  available?: number
}

export type DatasetActivationGate = {
  blockingIssueCount: number
  issues: ActivationBlockingIssue[]
}

export function validateDatasetForActivation(
  transactions: NormalizedTransaction[],
): DatasetActivationGate {
  const accounting = buildPortfolioAccounting(transactions)
  const cashLedger = buildCashFundingLedger(transactions)

  const securityIssues: ActivationBlockingIssue[] = accounting.issues
    .filter((issue) => issue.severity === 'BLOCKING')
    .map((issue) => ({
      domain: 'SECURITY_ACCOUNTING',
      code: issue.code,
      sourceRowNumber: issue.sourceRowNumber,
      tradeDate: issue.tradeDate,
      currency: issue.currency,
      message: issue.message,
    }))

  const cashIssues: ActivationBlockingIssue[] = cashLedger.issues.map((issue) => ({
    domain: 'CASH_FX_FUNDING',
    code: issue.code,
    sourceRowNumber: issue.sourceRowNumber,
    tradeDate: issue.tradeDate,
    currency: issue.currency,
    message: issue.message,
    required: issue.required,
    available: issue.available,
  }))

  const issues = [...securityIssues, ...cashIssues]
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber)

  return { blockingIssueCount: issues.length, issues }
}
