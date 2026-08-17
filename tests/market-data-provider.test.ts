import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchYahooDailyHistory, yahooSymbolForFx } from '../worker/market-data-provider'
import type { MarketInstrument } from '../src/lib/market-data-contracts'

const instrument: MarketInstrument = {
  instrumentType: 'SECURITY',
  ticker: 'TEST',
  currency: 'USD',
  providerSymbol: 'TEST',
  startDate: '2026-01-01',
}

afterEach(() => {
  vi.restoreAllMocks()
})

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Yahoo Finance daily raw-close adapter', () => {
  it('drops an unfinished current-session bar and preserves adjusted close separately', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      chart: {
        result: [{
          meta: {
            currency: 'USD',
            exchangeTimezoneName: 'America/New_York',
            currentTradingPeriod: { regular: { start: 1_767_627_000, end: 1_767_650_400 } },
          },
          timestamp: [1_767_541_200, 1_767_627_000],
          indicators: {
            quote: [{ close: [100, 105] }],
            adjclose: [{ adjclose: [99, 104] }],
          },
        }],
        error: null,
      },
    }))

    const result = await fetchYahooDailyHistory(
      instrument,
      fetcher,
      new Date('2026-01-05T16:00:00Z'),
    )

    expect(result.bars).toEqual([{ date: '2026-01-04', rawClose: 100, adjustedClose: 99 }])
    expect(result.latestRawClose).toBe(100)
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/v8/finance/chart/TEST?'),
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/json' }) }),
    )
  })

  it('blocks a provider currency mismatch', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      chart: {
        result: [{
          meta: { currency: 'TWD', exchangeTimezoneName: 'Asia/Taipei' },
          timestamp: [Math.floor(Date.parse('2026-01-02T14:30:00Z') / 1000)],
          indicators: { quote: [{ close: [100] }] },
        }],
      },
    }))

    await expect(fetchYahooDailyHistory(instrument, fetcher, new Date('2026-01-03T00:00:00Z')))
      .rejects.toThrow('幣別為 TWD，預期為 USD')
  })

  it('fails closed when the provider returns no completed close', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      chart: {
        result: [{
          meta: { currency: 'USD', exchangeTimezoneName: 'America/New_York' },
          timestamp: [],
          indicators: { quote: [{ close: [] }] },
        }],
      },
    }))

    await expect(fetchYahooDailyHistory(instrument, fetcher, new Date('2026-01-03T00:00:00Z')))
      .rejects.toThrow('沒有有效的已完成收盤價')
  })

  it('fails closed when the latest completed close is stale', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      chart: {
        result: [{
          meta: { currency: 'USD', exchangeTimezoneName: 'America/New_York' },
          timestamp: [Math.floor(Date.parse('2026-01-02T14:30:00Z') / 1000)],
          indicators: { quote: [{ close: [100] }] },
        }],
      },
    }))

    await expect(fetchYahooDailyHistory(instrument, fetcher, new Date('2026-02-01T00:00:00Z')))
      .rejects.toThrow('已超過 10 天')
  })

  it('uses Yahoo quote symbols for TWD conversion', () => {
    expect(yahooSymbolForFx('USD')).toBe('TWD=X')
    expect(yahooSymbolForFx('EUR')).toBe('EURTWD=X')
  })
})
