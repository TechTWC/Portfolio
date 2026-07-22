import type { DatasetDiff, NormalizedTransaction, TransactionChangeSample } from './contracts'

const SAMPLE_LIMIT = 20

function sample(row: NormalizedTransaction): TransactionChangeSample {
  return {
    tradeDate: row.tradeDate,
    transactionType: row.transactionType,
    ticker: row.ticker,
    currency: row.currency,
    quantity: row.quantity,
    price: row.price,
    amountForeign: row.amountForeign,
    rowHash: row.rowHash,
  }
}

export function compareTransactionSets(
  oldRows: NormalizedTransaction[],
  newRows: NormalizedTransaction[],
): DatasetDiff {
  const oldByHash = new Map(oldRows.map((row) => [row.rowHash, row]))
  const newByHash = new Map(newRows.map((row) => [row.rowHash, row]))
  const addedRows = [...newByHash.entries()]
    .filter(([hash]) => !oldByHash.has(hash))
    .map(([, row]) => row)
  const removedRows = [...oldByHash.entries()]
    .filter(([hash]) => !newByHash.has(hash))
    .map(([, row]) => row)
  const unchangedRows = [...newByHash.keys()].filter((hash) => oldByHash.has(hash)).length
  const dates = newRows.map((row) => row.tradeDate).sort()

  return {
    unchanged: addedRows.length === 0 && removedRows.length === 0 && oldRows.length === newRows.length,
    oldRowCount: oldRows.length,
    newRowCount: newRows.length,
    added: addedRows.length,
    removed: removedRows.length,
    unchangedRows,
    earliestDate: dates[0] ?? null,
    latestDate: dates.at(-1) ?? null,
    addedSamples: addedRows.slice(0, SAMPLE_LIMIT).map(sample),
    removedSamples: removedRows.slice(0, SAMPLE_LIMIT).map(sample),
  }
}
