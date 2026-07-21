import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction } from '../src/lib/contracts'
import { compareTransactionSets } from '../src/lib/diff'

function row(hash: string, date = '2026-01-01'): NormalizedTransaction {
  return {
    sourceRowNumber: 2,
    tradeDate: date,
    transactionType: 'SECURITY',
    ticker: '2330.TW',
    currency: 'TWD',
    quantity: 1,
    price: 100,
    amountForeign: 100,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: hash.repeat(64).slice(0, 64),
  }
}

describe('compareTransactionSets', () => {
  it('identifies unchanged datasets', () => {
    const rows = [row('a')]
    expect(compareTransactionSets(rows, rows)).toMatchObject({
      unchanged: true,
      added: 0,
      removed: 0,
      unchangedRows: 1,
    })
  })

  it('counts additions and removals by immutable row hash', () => {
    const result = compareTransactionSets([row('a')], [row('b', '2026-02-01')])
    expect(result).toMatchObject({
      unchanged: false,
      added: 1,
      removed: 1,
      earliestDate: '2026-02-01',
      latestDate: '2026-02-01',
    })
    expect(result.addedSamples[0]?.tradeDate).toBe('2026-02-01')
    expect(result.removedSamples[0]?.tradeDate).toBe('2026-01-01')
  })
})
