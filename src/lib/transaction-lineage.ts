import type {
  NormalizedTransaction,
  StoredTransaction,
  TransactionLineageSummary,
} from './contracts'

export type PlannedTransactionLineage = {
  transaction: NormalizedTransaction
  transactionId: string | null
  kind: 'UNCHANGED' | 'CORRECTED' | 'NEW'
}

export type TransactionLineagePlan = {
  rows: PlannedTransactionLineage[]
  summary: TransactionLineageSummary
}

function groupIndexes<T>(rows: T[], keyFor: (row: T) => string): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const key = keyFor(row)
    const indexes = groups.get(key) ?? []
    indexes.push(index)
    groups.set(key, indexes)
  })
  return groups
}

function correctionKey(row: NormalizedTransaction): string {
  return [
    row.sourceRowNumber,
    row.transactionType,
    row.ticker.toUpperCase(),
    row.currency.toUpperCase(),
  ].join('\u0000')
}

function semanticKey(row: NormalizedTransaction): string {
  return [
    row.tradeDate,
    row.transactionType,
    row.ticker.toUpperCase(),
    row.currency.toUpperCase(),
  ].join('\u0000')
}

export function planTransactionLineage(
  previous: StoredTransaction[],
  incoming: NormalizedTransaction[],
): TransactionLineagePlan {
  const planned: PlannedTransactionLineage[] = incoming.map((transaction) => ({
    transaction,
    transactionId: null,
    kind: 'NEW',
  }))
  const usedPrevious = new Set<number>()

  const previousByHash = groupIndexes(previous, (row) => row.rowHash)
  for (const [incomingIndex, row] of incoming.entries()) {
    const match = previousByHash.get(row.rowHash)?.find((index) => !usedPrevious.has(index))
    if (match === undefined) continue
    usedPrevious.add(match)
    planned[incomingIndex] = {
      transaction: row,
      transactionId: previous[match].transactionId,
      kind: 'UNCHANGED',
    }
  }

  const matchUniqueGroups = (
    keyFor: (row: NormalizedTransaction) => string,
    ambiguousKeys?: Set<string>,
    skipIncoming?: (row: NormalizedTransaction) => boolean,
  ) => {
    const remainingPrevious = previous
      .map((row, index) => ({ row, index }))
      .filter(({ index }) => !usedPrevious.has(index))
    const remainingIncoming = incoming
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => (
        planned[index].transactionId === null && !skipIncoming?.(row)
      ))
    const previousGroups = groupIndexes(remainingPrevious, ({ row }) => keyFor(row))
    const incomingGroups = groupIndexes(remainingIncoming, ({ row }) => keyFor(row))

    for (const [key, incomingGroupIndexes] of incomingGroups) {
      const previousGroupIndexes = previousGroups.get(key) ?? []
      if (previousGroupIndexes.length === 0) continue
      if (previousGroupIndexes.length !== 1 || incomingGroupIndexes.length !== 1) {
        ambiguousKeys?.add(key)
        continue
      }

      const previousEntry = remainingPrevious[previousGroupIndexes[0]]
      const incomingEntry = remainingIncoming[incomingGroupIndexes[0]]
      if (usedPrevious.has(previousEntry.index) || planned[incomingEntry.index].transactionId !== null) continue
      usedPrevious.add(previousEntry.index)
      planned[incomingEntry.index] = {
        transaction: incomingEntry.row,
        transactionId: previousEntry.row.transactionId,
        kind: 'CORRECTED',
      }
    }
  }

  // Prefer the unique semantic predecessor before considering source rows.
  // A deleted row can make a different transaction occupy its old row number,
  // so source position must never override a unique calendar/identity match.
  const ambiguousKeys = new Set<string>()
  matchUniqueGroups(semanticKey, ambiguousKeys)

  // Source row plus the same security/cash identity remains a safe fallback
  // for a one-to-one correction whose date itself changed. Repeated candidates
  // whose semantic group was already ambiguous are deliberately left unmatched
  // rather than letting a reused row number guess their lineage.
  matchUniqueGroups(
    correctionKey,
    undefined,
    (row) => ambiguousKeys.has(semanticKey(row)),
  )

  const summary: TransactionLineageSummary = {
    unchanged: planned.filter((row) => row.kind === 'UNCHANGED').length,
    corrected: planned.filter((row) => row.kind === 'CORRECTED').length,
    added: planned.filter((row) => row.kind === 'NEW').length,
    removed: previous.length - usedPrevious.size,
    ambiguous: planned.filter((row) => (
      row.kind === 'NEW' && ambiguousKeys.has(semanticKey(row.transaction))
    )).length,
  }

  return { rows: planned, summary }
}
