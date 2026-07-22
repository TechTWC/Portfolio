import { describe, expect, it } from 'vitest'
import { parseTransactionRows } from '../src/lib/parser'

describe('transaction parser', () => {
  it('converts a positive SELL quantity to a negative security quantity', async () => {
    const result = await parseTransactionRows([
      { 日期: '2026-01-01', 交易類型: 'SELL', 股票代號: '2330', 購買股數: 2, 購買股價: 100, 幣別: 'TWD' },
    ])
    expect(result.transactions[0].ticker).toBe('2330.TW')
    expect(result.transactions[0].quantity).toBe(-2)
  })

  it('accepts trimmed/case-insensitive aliases and derives security amount', async () => {
    const result = await parseTransactionRows([
      { ' Trade_Date ': '2026-01-02', TYPE: 'BUY', STOCK_ID: '2454', QTY: 3, TRADE_PRICE: 200, CCY: 'TWD' },
    ])
    expect(result.transactions[0]).toMatchObject({ ticker: '2454.TW', quantity: 3, amountForeign: 600 })
  })

  it('preserves identical fills with unique row hashes and a warning', async () => {
    const rows = [
      { 日期: '2026-01-01', 交易類型: 'BUY', 股票代號: '2330', 購買股數: 1, 購買股價: 100, 幣別: 'TWD' },
      { 日期: '2026-01-01', 交易類型: 'BUY', 股票代號: '2330', 購買股數: 1, 購買股價: 100, 幣別: 'TWD' },
    ]
    const result = await parseTransactionRows(rows)
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions[0].rowHash).not.toBe(result.transactions[1].rowHash)
    expect(result.warnings.join(' ')).toContain('獨立成交')
  })

  it('allows foreign CASH_OUT to use market FX fallback', async () => {
    const result = await parseTransactionRows([
      { 日期: '2026-01-01', 交易類型: 'CASH_OUT', 幣別: 'USD', 原幣金額: 100 },
    ])
    expect(result.transactions[0].fxRate).toBeNull()
    expect(result.warnings.join(' ')).toContain('市場匯率 fallback')
  })

  it('rejects foreign CASH_IN without its actual contribution FX', async () => {
    await expect(parseTransactionRows([
      { 日期: '2026-01-01', 交易類型: 'CASH_IN', 幣別: 'USD', 原幣金額: 100 },
    ])).rejects.toThrow('所有資料列都未通過驗證')
  })
})
