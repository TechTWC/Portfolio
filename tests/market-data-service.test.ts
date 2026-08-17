import { describe, expect, it } from 'vitest'
import type { StoredTransaction } from '../src/lib/contracts'
import { deriveMarketInstruments } from '../worker/market-data-service'

function security(
  sourceRowNumber: number,
  tradeDate: string,
  ticker: string,
  currency: string,
  quantity = 1,
): StoredTransaction {
  return {
    transactionId: `transaction-${sourceRowNumber}`,
    sourceRowNumber,
    tradeDate,
    transactionType: 'SECURITY',
    ticker,
    currency,
    quantity,
    price: 100,
    amountForeign: 100,
    fxRate: currency === 'TWD' ? 1 : 32,
    fee: 0,
    budgetWaterline: null,
    budgetBalance: null,
    note: '',
    rowHash: String(sourceRowNumber).padStart(64, '0'),
  }
}

describe('automatic market-data universe', () => {
  it('includes sold securities, the SPY benchmark, and required FX history', () => {
    const rows = [
      security(2, '2021-05-13', 'VOO', 'USD', 1),
      security(3, '2021-05-27', '006208.TW', 'TWD', 1000),
      security(4, '2022-01-01', 'VOO', 'USD', -1),
    ]
    const instruments = deriveMarketInstruments(rows)

    expect(instruments).toEqual(expect.arrayContaining([
      expect.objectContaining({ instrumentType: 'SECURITY', ticker: 'VOO', startDate: '2021-05-13' }),
      expect.objectContaining({ instrumentType: 'SECURITY', ticker: '006208.TW', currency: 'TWD' }),
      expect.objectContaining({ instrumentType: 'BENCHMARK', ticker: 'SPY', startDate: '2021-05-13' }),
      expect.objectContaining({ instrumentType: 'FX', currency: 'USD', providerSymbol: 'TWD=X' }),
    ]))
  })

  it('re-fetches a ten-day overlap instead of downloading all history again', () => {
    const rows = [security(2, '2021-05-13', 'VOO', 'USD')]
    const latest = new Map([
      ['SECURITY\u0000VOO\u0000USD', '2026-08-14'],
      ['BENCHMARK\u0000SPY\u0000USD', '2026-08-14'],
      ['FX\u0000\u0000USD', '2026-08-14'],
    ])

    const instruments = deriveMarketInstruments(rows, latest)
    expect(instruments.every((item) => item.startDate === '2026-08-04')).toBe(true)
  })

  it('blocks the same ticker mapped to conflicting currencies', () => {
    const rows = [
      security(2, '2026-01-01', 'TEST', 'USD'),
      security(3, '2026-01-02', 'TEST', 'TWD'),
    ]
    expect(() => deriveMarketInstruments(rows)).toThrow('同時出現 USD 與 TWD')
  })
})
