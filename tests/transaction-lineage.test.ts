import { describe, expect, it } from 'vitest'
import type { NormalizedTransaction, StoredTransaction } from '../src/lib/contracts'
import { planTransactionLineage } from '../src/lib/transaction-lineage'

function row(
  transactionId: string,
  rowHash: string,
  overrides: Partial<NormalizedTransaction> = {},
): StoredTransaction {
  return {
    transactionId,
    sourceRowNumber: 2,
    tradeDate: '2026-01-02',
    transactionType: 'SECURITY',
    ticker: '2330.TW',
    currency: 'TWD',
    quantity: 10,
    price: 100,
    amountForeign: 1_000,
    fxRate: 1,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: rowHash.repeat(64).slice(0, 64),
    ...overrides,
  }
}

function incoming(stored: StoredTransaction, overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  const { transactionId: _transactionId, ...transaction } = stored
  return { ...transaction, ...overrides }
}

describe('transaction lineage planning', () => {
  it('retains logical IDs for unchanged rows even when their order changes', () => {
    const first = row('txn-1', 'a', { sourceRowNumber: 2 })
    const second = row('txn-2', 'b', { sourceRowNumber: 3, ticker: 'AAPL', currency: 'USD' })
    const result = planTransactionLineage([first, second], [
      incoming(second, { sourceRowNumber: 2 }),
      incoming(first, { sourceRowNumber: 3 }),
    ])

    expect(result.rows.map((entry) => entry.transactionId)).toEqual(['txn-2', 'txn-1'])
    expect(result.summary).toEqual({ unchanged: 2, corrected: 0, added: 0, removed: 0, ambiguous: 0 })
  })

  it('retains an ID for a unique high-confidence correction', () => {
    const previous = row('txn-1', 'a')
    const corrected = incoming(previous, { price: 105, amountForeign: 1_050, rowHash: 'b'.repeat(64) })
    const result = planTransactionLineage([previous], [corrected])

    expect(result.rows[0]).toMatchObject({ transactionId: 'txn-1', kind: 'CORRECTED' })
    expect(result.summary.corrected).toBe(1)
  })

  it('retains an ID for a uniquely identifiable correction that moved rows', () => {
    const previous = row('txn-1', 'a', { sourceRowNumber: 2 })
    const corrected = incoming(previous, {
      sourceRowNumber: 8,
      price: 105,
      amountForeign: 1_050,
      rowHash: 'b'.repeat(64),
    })
    const result = planTransactionLineage([previous], [corrected])

    expect(result.rows[0]).toMatchObject({ transactionId: 'txn-1', kind: 'CORRECTED' })
  })

  it('retains the source-row fallback for a unique date correction', () => {
    const previous = row('txn-1', 'a', { sourceRowNumber: 2 })
    const corrected = incoming(previous, {
      tradeDate: '2026-01-03',
      price: 105,
      amountForeign: 1_050,
      rowHash: 'b'.repeat(64),
    })

    const result = planTransactionLineage([previous], [corrected])

    expect(result.rows[0]).toMatchObject({ transactionId: 'txn-1', kind: 'CORRECTED' })
    expect(result.summary).toEqual({ unchanged: 0, corrected: 1, added: 0, removed: 0, ambiguous: 0 })
  })

  it('does not guess from a semantic match when a repeated identity row was removed', () => {
    const removed = row('txn-1', 'a', {
      sourceRowNumber: 2,
      tradeDate: '2026-01-01',
    })
    const retained = row('txn-2', 'b', {
      sourceRowNumber: 3,
      tradeDate: '2026-01-02',
    })
    const corrected = incoming(retained, {
      sourceRowNumber: 2,
      price: 105,
      amountForeign: 1_050,
      rowHash: 'c'.repeat(64),
    })

    const result = planTransactionLineage([removed, retained], [corrected])

    expect(result.rows[0]).toMatchObject({ transactionId: null, kind: 'NEW' })
    expect(result.summary).toEqual({ unchanged: 0, corrected: 0, added: 1, removed: 2, ambiguous: 1 })
  })

  it('does not guess IDs for ambiguous repeated trades', () => {
    const first = row('txn-1', 'a', { sourceRowNumber: 2 })
    const second = row('txn-2', 'b', { sourceRowNumber: 3 })
    const candidates = [
      incoming(first, { sourceRowNumber: 8, price: 101, rowHash: 'c'.repeat(64) }),
      incoming(second, { sourceRowNumber: 9, price: 102, rowHash: 'd'.repeat(64) }),
    ]
    const result = planTransactionLineage([first, second], candidates)

    expect(result.rows.map((entry) => entry.transactionId)).toEqual([null, null])
    expect(result.summary).toEqual({ unchanged: 0, corrected: 0, added: 2, removed: 2, ambiguous: 2 })
  })

  it('does not trust an occurrence hash after one identical fill was removed', () => {
    const removed = row('txn-1', 'a', { sourceRowNumber: 2 })
    const survivor = row('txn-2', 'b', { sourceRowNumber: 3 })
    const shiftedOccurrence = incoming(survivor, {
      sourceRowNumber: 2,
      rowHash: removed.rowHash,
    })

    const result = planTransactionLineage([removed, survivor], [shiftedOccurrence])

    expect(result.rows[0]).toMatchObject({ transactionId: null, kind: 'NEW' })
    expect(result.summary).toEqual({ unchanged: 0, corrected: 0, added: 1, removed: 2, ambiguous: 1 })
  })

  it('does not fall back to a reused source row for an ambiguous semantic group', () => {
    const first = row('txn-1', 'a', { sourceRowNumber: 2 })
    const second = row('txn-2', 'b', { sourceRowNumber: 3 })
    const correctedSurvivor = incoming(first, {
      sourceRowNumber: 2,
      quantity: 15,
      amountForeign: 1_500,
      rowHash: 'c'.repeat(64),
    })

    const result = planTransactionLineage([first, second], [correctedSurvivor])

    expect(result.rows[0]).toMatchObject({ transactionId: null, kind: 'NEW' })
    expect(result.summary).toEqual({ unchanged: 0, corrected: 0, added: 1, removed: 2, ambiguous: 1 })
  })

  it('does not reuse a deleted row ID when the ambiguous survivor also changes date', () => {
    const removed = row('txn-1', 'a', { sourceRowNumber: 2 })
    const survivor = row('txn-2', 'b', { sourceRowNumber: 3 })
    const correctedSurvivor = incoming(survivor, {
      sourceRowNumber: 2,
      tradeDate: '2026-01-03',
      quantity: 15,
      amountForeign: 1_500,
      rowHash: 'c'.repeat(64),
    })

    const result = planTransactionLineage([removed, survivor], [correctedSurvivor])

    expect(result.rows[0]).toMatchObject({ transactionId: null, kind: 'NEW' })
    expect(result.summary).toEqual({ unchanged: 0, corrected: 0, added: 1, removed: 2, ambiguous: 1 })
  })

  it('does not reuse a deleted row ID when the survivor changes to the deleted date', () => {
    const removed = row('txn-1', 'a', {
      sourceRowNumber: 2,
      tradeDate: '2026-01-01',
    })
    const survivor = row('txn-2', 'b', {
      sourceRowNumber: 3,
      tradeDate: '2026-01-02',
    })
    const correctedSurvivor = incoming(survivor, {
      sourceRowNumber: 2,
      tradeDate: '2026-01-01',
      price: 105,
      amountForeign: 1_050,
      rowHash: 'c'.repeat(64),
    })

    const result = planTransactionLineage([removed, survivor], [correctedSurvivor])

    expect(result.rows[0]).toMatchObject({ transactionId: null, kind: 'NEW' })
    expect(result.summary).toEqual({ unchanged: 0, corrected: 0, added: 1, removed: 2, ambiguous: 1 })
  })

  it('reports genuine additions and removals without linking them', () => {
    const removed = row('txn-1', 'a')
    const added = incoming(row('unused', 'b', { ticker: 'AAPL', currency: 'USD' }))
    const result = planTransactionLineage([removed], [added])

    expect(result.rows[0]).toMatchObject({ transactionId: null, kind: 'NEW' })
    expect(result.summary).toEqual({ unchanged: 0, corrected: 0, added: 1, removed: 1, ambiguous: 0 })
  })
})
