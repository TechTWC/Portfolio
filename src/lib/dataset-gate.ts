import { buildPortfolioAccounting } from './accounting'
import { buildCashFundingLedger } from './cash-ledger'
import type { NormalizedTransaction } from './contracts'
import { buildFxCostPool } from './fx-cost-pool'

export type ActivationBlockingIssue = {
  domain: 'SECURITY_ACCOUNTING' | 'CASH_FX_FUNDING' | 'FX_COST_BASIS'
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
  const fxCostPool = buildFxCostPool(transactions)

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

  // Existing security/cash gates remain the primary message for a row. The FX
  // basis gate only adds issues that those ledgers cannot see, avoiding duplicate
  // warnings for the same oversell, missing funding, or excessive withdrawal.
  const alreadyBlockedRows = new Set(
    [...securityIssues, ...cashIssues].map((issue) => issue.sourceRowNumber),
  )
  const fxBasisIssues: ActivationBlockingIssue[] = fxCostPool.issues
    .filter((issue) => !alreadyBlockedRows.has(issue.sourceRowNumber))
    .map((issue) => ({
      domain: 'FX_COST_BASIS',
      code: issue.code,
      sourceRowNumber: issue.sourceRowNumber,
      tradeDate: issue.tradeDate,
      currency: issue.currency,
      message: issue.message,
      required: issue.required,
      available: issue.available,
    }))

  const issues = [...securityIssues, ...cashIssues, ...fxBasisIssues]
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber)

  return { blockingIssueCount: issues.length, issues }
}
