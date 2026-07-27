import { afterEach, describe, expect, it } from 'vitest'
import { parseValuationRows } from '../src/lib/valuation-parser'

const originalTimeZone = process.env.TZ

afterEach(() => {
  process.env.TZ = originalTimeZone
})

describe('valuation snapshot parser', () => {
  it('normalizes Taiwan tickers and parses price and FX marks', async () => {
    const result = await parseValuationRows([
      {
        估值日: '2026-06-30',
        標記日期: '2026-06-30',
        類型: '股價',
        股票代號: '2330',
        幣別: '',
        數值: '1100',
        來源: 'SYNTHETIC',
      },
      {
        估值日: '2026-06-30',
        標記日期: '2026-06-30',
        類型: 'FX',
        股票代號: '',
        幣別: 'USD',
        數值: '33',
        來源: 'SYNTHETIC',
      },
    ])

    expect(result.valuationDate).toBe('2026-06-30')
    expect(result.rejected).toHaveLength(0)
    expect(result.marks).toHaveLength(2)
    expect(result.marks[0]).toMatchObject({
      markType: 'FX',
      ticker: '',
      currency: 'USD',
      value: 33,
    })
    expect(result.marks[1]).toMatchObject({
      markType: 'PRICE',
      ticker: '2330.TW',
      currency: 'TWD',
      value: 1100,
    })
  })

  it('preserves Taiwan-local spreadsheet calendar dates without shifting to the previous UTC day', async () => {
    process.env.TZ = 'Asia/Taipei'
    const calendarDate = new Date(2026, 5, 30)
    expect(calendarDate.toISOString().slice(0, 10)).toBe('2026-06-29')

    const result = await parseValuationRows([
      {
        估值日: calendarDate,
        標記日期: calendarDate,
        類型: 'FX',
        幣別: 'USD',
        數值: 33,
      },
    ])

    expect(result.valuationDate).toBe('2026-06-30')
    expect(result.marks[0].markDate).toBe('2026-06-30')
  })

  it('rejects a file containing multiple valuation dates', async () => {
    await expect(parseValuationRows([
      { 估值日: '2026-06-30', 標記日期: '2026-06-30', 類型: 'FX', 幣別: 'USD', 數值: 33 },
      { 估值日: '2026-07-01', 標記日期: '2026-06-30', 類型: 'FX', 幣別: 'EUR', 數值: 36 },
    ])).rejects.toThrow('同一份估值檔只能包含一個估值日')
  })

  it('warns when a mark is later than the valuation date', async () => {
    const result = await parseValuationRows([
      { 估值日: '2026-06-30', 標記日期: '2026-07-01', 類型: 'FX', 幣別: 'USD', 數值: 33 },
    ])

    expect(result.warnings).toContain('1 筆標記日期晚於估值日，Point-in-Time 引擎將忽略')
  })

  it('rejects a PRICE row without ticker while preserving valid rows', async () => {
    const result = await parseValuationRows([
      { 估值日: '2026-06-30', 標記日期: '2026-06-30', 類型: 'PRICE', 股票代號: '', 幣別: 'USD', 數值: 100 },
      { 估值日: '2026-06-30', 標記日期: '2026-06-30', 類型: 'FX', 幣別: 'USD', 數值: 33 },
    ])

    expect(result.marks).toHaveLength(1)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].sourceRowNumber).toBe(2)
  })
})
