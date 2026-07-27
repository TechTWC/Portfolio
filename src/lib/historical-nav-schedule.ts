import type { NormalizedTransaction } from './contracts'
import type { ValuationMark } from './valuation'

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function deriveHistoricalNavDates(
  marks: ValuationMark[],
  activeValuationDate: string | null,
  transactions: NormalizedTransaction[] = [],
): string[] {
  const earliestTransactionDate = transactions
    .map((row) => row.tradeDate)
    .filter(isIsoDate)
    .sort()[0]
  if (
    !earliestTransactionDate
    || !activeValuationDate
    || !isIsoDate(activeValuationDate)
    || earliestTransactionDate > activeValuationDate
  ) {
    return []
  }

  const dates = new Set<string>([earliestTransactionDate, activeValuationDate])

  for (const mark of marks) {
    if (
      (mark.markType === 'PRICE' || mark.markType === 'FX')
      && isIsoDate(mark.markDate)
      && mark.markDate >= earliestTransactionDate
      && mark.markDate <= activeValuationDate
    ) {
      dates.add(mark.markDate)
    }
  }

  for (const row of transactions) {
    if (
      (row.transactionType === 'CASH_IN' || row.transactionType === 'CASH_OUT')
      && isIsoDate(row.tradeDate)
      && row.tradeDate >= earliestTransactionDate
      && row.tradeDate <= activeValuationDate
    ) {
      dates.add(row.tradeDate)
    }
  }

  return [...dates].sort()
}
