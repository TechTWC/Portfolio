import { describe, expect, it } from 'vitest'
import { compareValuationMarks } from '../src/lib/valuation-diff'
import type { NormalizedValuationMark } from '../src/lib/valuation-contracts'

function mark(overrides: Partial<NormalizedValuationMark>): NormalizedValuationMark {
  return {
    sourceRowNumber: 2,
    markDate: '2026-06-30',
    markType: 'PRICE',
    ticker: 'AAPL',
    currency: 'USD',
    value: 250,
    source: 'SYNTHETIC',
    rowHash: 'a'.repeat(64),
    ...overrides,
  }
}

describe('valuation snapshot diff', () => {
  it('treats a changed value as one removed and one added mark', () => {
    const oldMarks = [mark({ value: 250, rowHash: 'a'.repeat(64) })]
    const newMarks = [mark({ value: 260, rowHash: 'b'.repeat(64) })]

    expect(compareValuationMarks(oldMarks, newMarks)).toMatchObject({
      unchanged: false,
      oldMarkCount: 1,
      newMarkCount: 1,
      added: 1,
      removed: 1,
      unchangedMarks: 0,
    })
  })

  it('recognizes an unchanged snapshot by stable row hashes', () => {
    const rows = [
      mark({ rowHash: 'a'.repeat(64) }),
      mark({ ticker: '', markType: 'FX', currency: 'USD', value: 33, rowHash: 'b'.repeat(64) }),
    ]

    expect(compareValuationMarks(rows, [...rows])).toMatchObject({
      unchanged: true,
      added: 0,
      removed: 0,
      unchangedMarks: 2,
    })
  })
})
