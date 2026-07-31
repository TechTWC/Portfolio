import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseTransactionFile, parseTransactionRows } from '../src/lib/parser'
import {
  MAX_SPREADSHEET_FILE_BYTES,
  MAX_SPREADSHEET_ROWS,
} from '../src/lib/spreadsheet-safety'

function workbookFile(bookType: 'xlsx' | 'xls', rows: unknown[][]): File {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Transactions')
  const bytes = XLSX.write(workbook, { bookType, type: 'array', compression: true })
  return new File([bytes], `synthetic.${bookType}`)
}

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

  it.each(['xlsx', 'xls'] as const)('parses a synthetic %s workbook without changing the financial result', async (bookType) => {
    const file = workbookFile(bookType, [
      ['日期', '交易類型', '股票代號', '購買股數', '購買股價', '幣別'],
      ['2026-01-02', 'BUY', '2330', 2, 100, 'TWD'],
    ])

    const result = await parseTransactionFile(file)

    expect(result.rejected).toHaveLength(0)
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0]).toMatchObject({
      tradeDate: '2026-01-02',
      ticker: '2330.TW',
      quantity: 2,
      amountForeign: 200,
    })
  })

  it.each(['xlsx', 'xls'] as const)('reports a corrupted %s file as a file-format error', async (bookType) => {
    const file = new File(
      ['This is not an Excel workbook.'],
      `corrupted.${bookType}`,
    )

    await expect(parseTransactionFile(file)).rejects.toThrow(
      'Excel 檔案損壞或副檔名與格式不符',
    )
  })

  it('parses an Excel serial date and preserves the source row for malformed input', async () => {
    const result = await parseTransactionRows([
      { 日期: 46023, 交易類型: 'BUY', 股票代號: '2330', 購買股數: 1, 購買股價: 100, 幣別: 'TWD' },
      { 日期: '2026-01-02', 交易類型: 'BUY', 股票代號: '', 購買股數: 1, 購買股價: 100, 幣別: 'TWD' },
    ])

    expect(result.transactions[0].tradeDate).toBe('2026-01-01')
    expect(result.rejected).toEqual([
      { sourceRowNumber: 3, reason: '第 3 列缺少股票代號' },
    ])
  })

  it('does not allow a prototype-key workbook to modify object prototypes', async () => {
    const file = workbookFile('xlsx', [
      ['日期', '交易類型', '股票代號', '購買股數', '購買股價', '幣別', '__proto__'],
      ['2026-01-02', 'BUY', '2330', 1, 100, 'TWD', 'polluted'],
    ])

    const result = await parseTransactionFile(file)

    expect(result.transactions).toHaveLength(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects an oversized workbook before reading its contents', async () => {
    const file = new File(
      [new Uint8Array(MAX_SPREADSHEET_FILE_BYTES + 1)],
      'oversized.xlsx',
    )

    await expect(parseTransactionFile(file)).rejects.toThrow('試算表檔案過大')
  })

  it('rejects row input above the processing bound', async () => {
    const rows = Array.from(
      { length: MAX_SPREADSHEET_ROWS + 1 },
      () => ({ 日期: '2026-01-01' }),
    )

    await expect(parseTransactionRows(rows)).rejects.toThrow('試算表資料列過多')
  })

  it('rejects a real workbook truncated at an interspersed blank row', async () => {
    const dataRow = ['2026-01-02', 'BUY', '2330', 1, 100, 'TWD']
    const file = workbookFile('xlsx', [
      ['日期', '交易類型', '股票代號', '購買股數', '購買股價', '幣別'],
      [],
      ...Array.from({ length: MAX_SPREADSHEET_ROWS + 1 }, () => dataRow),
    ])

    await expect(parseTransactionFile(file)).rejects.toThrow('試算表資料列過多；上限為 50,000 列')
  }, 30_000)

  it('parses a normal workbook with a blank row and the exact supported boundary', async () => {
    const dataRow = ['2026-01-02', 'BUY', '2330', 1, 100, 'TWD']
    const normal = workbookFile('xlsx', [
      ['日期', '交易類型', '股票代號', '購買股數', '購買股價', '幣別'],
      dataRow,
      [],
      dataRow,
    ])
    const boundary = workbookFile('xlsx', [
      ['日期', '交易類型', '股票代號', '購買股數', '購買股價', '幣別'],
      ...Array.from({ length: MAX_SPREADSHEET_ROWS }, () => dataRow),
    ])

    await expect(parseTransactionFile(normal)).resolves.toMatchObject({ sourceRowCount: 2 })
    await expect(parseTransactionFile(boundary)).resolves.toMatchObject({ sourceRowCount: MAX_SPREADSHEET_ROWS })
  }, 30_000)
})
