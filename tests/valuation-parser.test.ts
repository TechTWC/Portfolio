import { afterEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseValuationFile, parseValuationRows } from '../src/lib/valuation-parser'
import { MAX_SPREADSHEET_ROWS } from '../src/lib/spreadsheet-safety'

const originalTimeZone = process.env.TZ

function workbookFile(rows: unknown[][]): File {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Valuations')
  return new File([XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true })], 'valuations.xlsx')
}

function csvFile(rows: unknown[][]): File {
  const contents = rows
    .map((row) => row.map((value) => String(value ?? '')).join(','))
    .join('\n')
  return new File([contents], 'valuations.csv', { type: 'text/csv' })
}

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

  it('rejects a real workbook truncated at an interspersed blank row', async () => {
    const dataRow = ['2026-06-30', '2026-06-30', 'FX', '', 'USD', 33]
    const file = workbookFile([
      ['估值日', '標記日期', '類型', '股票代號', '幣別', '數值'],
      [],
      ...Array.from({ length: MAX_SPREADSHEET_ROWS + 1 }, () => dataRow),
    ])

    await expect(parseValuationFile(file)).rejects.toThrow('試算表資料列過多；上限為 50,000 列')
  }, 30_000)

  it('rejects a truncated CSV when SheetJS omits the original range', async () => {
    const header = ['估值日', '標記日期', '類型', '股票代號', '幣別', '數值']
    const dataRow = ['2026-06-30', '2026-06-30', 'FX', '', 'USD', 33]
    const file = csvFile([
      header,
      dataRow,
      [],
      ...Array.from({ length: MAX_SPREADSHEET_ROWS }, () => dataRow),
    ])

    await expect(parseValuationFile(file)).rejects.toThrow('試算表資料列過多；上限為 50,000 列')
  }, 30_000)

  it('parses a normal CSV containing a blank row', async () => {
    const header = ['估值日', '標記日期', '類型', '股票代號', '幣別', '數值']
    const dataRow = ['2026-06-30', '2026-06-30', 'FX', '', 'USD', 33]
    const file = csvFile([header, dataRow, [], dataRow])

    await expect(parseValuationFile(file)).resolves.toMatchObject({ sourceRowCount: 2 })
  })

  it('parses a normal workbook with a blank row and the exact supported boundary', async () => {
    const dataRow = ['2026-06-30', '2026-06-30', 'FX', '', 'USD', 33]
    const normal = workbookFile([
      ['估值日', '標記日期', '類型', '股票代號', '幣別', '數值'],
      dataRow,
      [],
      dataRow,
    ])
    const boundary = workbookFile([
      ['估值日', '標記日期', '類型', '股票代號', '幣別', '數值'],
      ...Array.from({ length: MAX_SPREADSHEET_ROWS }, () => dataRow),
    ])

    await expect(parseValuationFile(normal)).resolves.toMatchObject({ sourceRowCount: 2 })
    await expect(parseValuationFile(boundary)).resolves.toMatchObject({ sourceRowCount: MAX_SPREADSHEET_ROWS })
  }, 30_000)
})
