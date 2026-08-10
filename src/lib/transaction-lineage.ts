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

function lineageIdentityKey(row: NormalizedTransaction): string {
  return [
    row.transactionType,
    row.ticker.toUpperCase(),
    row.currency.toUpperCase(),
  ].join('\u0000')
}

function lineageContentKey(row: NormalizedTransaction): string {
  return JSON.stringify([
    row.tradeDate,
    row.transactionType,
    row.ticker.toUpperCase(),
    row.currency.toUpperCase(),
    row.quantity,
    row.price,
    row.amountForeign,
    row.fxRate,
    row.fee,
    row.budgetWaterline,
    row.budgetBalance,
    row.note,
  ])
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
  const ambiguousIncomingIndexes = new Set<number>()

  // Repeated identical fills use occurrence-based hashes. When their count
  // changes, those occurrence numbers can shift and make a survivor carry the
  // deleted fill's hash. Do not treat such a hash as stable lineage evidence.
  const previousContentGroups = groupIndexes(previous, lineageContentKey)
  const incomingContentGroups = groupIndexes(incoming, lineageContentKey)
  for (const [key, incomingGroupIndexes] of incomingContentGroups) {
    const previousGroupIndexes = previousContentGroups.get(key) ?? []
    if (previousGroupIndexes.length === 0) continue
    if (previousGroupIndexes.length === incomingGroupIndexes.length) continue
    for (const incomingIndex of incomingGroupIndexes) {
      ambiguousIncomingIndexes.add(incomingIndex)
    }
  }

  const previousByHash = groupIndexes(previous, (row) => row.rowHash)
  for (const [incomingIndex, row] of incoming.entries()) {
    if (ambiguousIncomingIndexes.has(incomingIndex)) continue
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
    ambiguousIncomingIndexes?: Set<number>,
    skipIncoming?: (row: NormalizedTransaction, index: number) => boolean,
  ) => {
    const remainingPrevious = previous
      .map((row, index) => ({ row, index }))
      .filter(({ index }) => !usedPrevious.has(index))
    const remainingIncoming = incoming
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => (
        planned[index].transactionId === null && !skipIncoming?.(row, index)
      ))
    const previousGroups = groupIndexes(remainingPrevious, ({ row }) => keyFor(row))
    const incomingGroups = groupIndexes(remainingIncoming, ({ row }) => keyFor(row))

    for (const [key, incomingGroupIndexes] of incomingGroups) {
      const previousGroupIndexes = previousGroups.get(key) ?? []
      if (previousGroupIndexes.length === 0) continue
      if (previousGroupIndexes.length !== 1 || incomingGroupIndexes.length !== 1) {
        for (const groupIndex of incomingGroupIndexes) {
          ambiguousIncomingIndexes?.add(remainingIncoming[groupIndex].index)
        }
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

  // Detect identity groups whose remaining row counts no longer agree before
  // semantic matching consumes one candidate. A delete plus a date correction
  // can otherwise make the survivor look exactly like the deleted row and
  // silently inherit its transaction ID.
  const preSemanticPrevious = previous
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => !usedPrevious.has(index))
  const preSemanticIncoming = incoming
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => planned[index].transactionId === null)
  const preSemanticPreviousIdentityGroups = groupIndexes(
    preSemanticPrevious,
    ({ row }) => lineageIdentityKey(row),
  )
  const preSemanticIncomingIdentityGroups = groupIndexes(
    preSemanticIncoming,
    ({ row }) => lineageIdentityKey(row),
  )

  for (const [key, incomingGroupIndexes] of preSemanticIncomingIdentityGroups) {
    const previousGroupIndexes = preSemanticPreviousIdentityGroups.get(key) ?? []
    if (previousGroupIndexes.length === 0) continue
    if (previousGroupIndexes.length === 1 && incomingGroupIndexes.length === 1) continue
    for (const groupIndex of incomingGroupIndexes) {
      ambiguousIncomingIndexes.add(preSemanticIncoming[groupIndex].index)
    }
  }

  // Prefer a unique semantic predecessor only when the surrounding identity
  // group is one-to-one. Source position cannot make repeated trades safe to
  // match after any mutable field changes.
  matchUniqueGroups(
    semanticKey,
    ambiguousIncomingIndexes,
    (_row, index) => ambiguousIncomingIndexes.has(index),
  )

  // A changed date removes the semantic-key evidence. Before using source row
  // as a fallback, require the remaining identity candidates on both sides to
  // be one-to-one. Otherwise a deleted repeated trade can make its old row
  // point at a different survivor, and the row number would guess the lineage.
  const remainingPrevious = previous
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => !usedPrevious.has(index))
  const remainingIncoming = incoming
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => planned[index].transactionId === null)
  const previousIdentityGroups = groupIndexes(remainingPrevious, ({ row }) => lineageIdentityKey(row))
  const incomingIdentityGroups = groupIndexes(remainingIncoming, ({ row }) => lineageIdentityKey(row))

  for (const [key, incomingGroupIndexes] of incomingIdentityGroups) {
    const previousGroupIndexes = previousIdentityGroups.get(key) ?? []
    if (previousGroupIndexes.length === 0) continue
    if (previousGroupIndexes.length === 1 && incomingGroupIndexes.length === 1) continue
    for (const groupIndex of incomingGroupIndexes) {
      ambiguousIncomingIndexes.add(remainingIncoming[groupIndex].index)
    }
  }

  // Source row plus the same security/cash identity remains a safe fallback
  // for a one-to-one correction whose date itself changed. Repeated candidates
  // whose semantic group was already ambiguous are deliberately left unmatched
  // rather than letting a reused row number guess their lineage.
  matchUniqueGroups(
    correctionKey,
    undefined,
    (_row, index) => ambiguousIncomingIndexes.has(index),
  )

  const summary: TransactionLineageSummary = {
    unchanged: planned.filter((row) => row.kind === 'UNCHANGED').length,
    corrected: planned.filter((row) => row.kind === 'CORRECTED').length,
    added: planned.filter((row) => row.kind === 'NEW').length,
    removed: previous.length - usedPrevious.size,
    ambiguous: planned.filter((row, index) => (
      row.kind === 'NEW' && ambiguousIncomingIndexes.has(index)
    )).length,
  }

  return { rows: planned, summary }
}
