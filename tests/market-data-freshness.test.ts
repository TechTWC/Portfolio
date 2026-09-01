import { describe, expect, it } from 'vitest'
import {
  determineDateFreshness,
  staleMarketDataMessage,
} from '../src/lib/market-data-freshness'

describe('market-data calendar freshness', () => {
  it('marks the Production 8/18 snapshot stale on 9/1 with an explicit age', () => {
    const result = determineDateFreshness('2026-08-18', new Date('2026-09-01T12:00:00Z'))

    expect(result).toMatchObject({
      stale: true,
      ageDays: 14,
      staleAfterDays: 4,
      reason: 'AGE_LIMIT_EXCEEDED',
    })
    expect(staleMarketDataMessage('2026-08-18', result.ageDays))
      .toBe('行情截至 2026-08-18，已過期 14 天')
  })

  it('allows a Friday close through the following Tuesday without hiding weekend data', () => {
    expect(determineDateFreshness('2026-08-28', new Date('2026-09-01T12:00:00Z')))
      .toMatchObject({ stale: false, ageDays: 4, reason: 'CURRENT' })
  })

  it('fails closed for missing and future dates', () => {
    expect(determineDateFreshness(null, new Date('2026-09-01T00:00:00Z')).reason).toBe('MISSING_DATE')
    expect(determineDateFreshness('2026-09-02', new Date('2026-09-01T00:00:00Z')).reason).toBe('FUTURE_DATE')
  })
})
