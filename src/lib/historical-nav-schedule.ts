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
  const dates = new Set<string>()

  for (const mark of marks) {
    if (mark.markType === 'PRICE' && isIsoDate(mark.markDate)) dates.add(mark.markDate)
  }

  const earliestTransactionDate = transactions
    .map((row) => row.tradeDate)
    .filter(isIsoDate)
    .sort()[0]
  if (earliestTransactionDate) dates.add(earliestTransactionDate)

  if (activeValuationDate && isIsoDate(activeValuationDate)) dates.add(activeValuationDate)

  return [...dates].sort()
}
