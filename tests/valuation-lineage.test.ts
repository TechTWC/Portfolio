import { describe, expect, it } from 'vitest'
import {
  determineValuationFreshness,
  transactionBindingMatches,
} from '../src/lib/valuation-lineage'

describe('valuation transaction binding', () => {
  const binding = { transactionDatasetId: 'dataset-v6', transactionRevision: 6 }

  it('is current only when both dataset identity and revision match', () => {
    expect(transactionBindingMatches(binding, {
      activeDatasetId: 'dataset-v6',
      cloudRevision: 6,
    })).toBe(true)
    expect(transactionBindingMatches(binding, {
      activeDatasetId: 'dataset-v7',
      cloudRevision: 7,
    })).toBe(false)
  })

  it('becomes stale without changing the stored binding', () => {
    expect(determineValuationFreshness(binding, {
      activeDatasetId: 'dataset-v7',
      cloudRevision: 7,
    })).toBe('STALE')
    expect(binding).toEqual({ transactionDatasetId: 'dataset-v6', transactionRevision: 6 })
  })

  it('reports no snapshot separately from stale data', () => {
    expect(determineValuationFreshness(null, {
      activeDatasetId: 'dataset-v6',
      cloudRevision: 6,
    })).toBe('NO_SNAPSHOT')
  })
})
