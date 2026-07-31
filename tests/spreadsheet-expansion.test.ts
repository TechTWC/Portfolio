import { describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { parseTransactionFile } from '../src/lib/parser'
import {
  assertXlsxZipExpansionIsSafe,
  MAX_XLSX_UNCOMPRESSED_BYTES,
  XLSX_EXPANSION_LIMIT_MESSAGE,
} from '../src/lib/spreadsheet-safety'
import { parseValuationFile } from '../src/lib/valuation-parser'

vi.mock('xlsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('xlsx')>()
  return { ...actual, read: vi.fn(actual.read) }
})

function workbookBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '交易類型', '股票代號', '購買股數', '購買股價', '幣別'],
    ['2026-01-02', 'BUY', '2330', 1, 100, 'TWD'],
  ]), 'Sheet1')
  return new Uint8Array(XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true }))
}

function centralEntries(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offsets: number[] = []
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      offsets.push(offset)
      offset += 45 + view.getUint16(offset + 28, true)
        + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    }
  }
  return offsets
}

function withCentralSizes(sizes: Array<{ compressed: number; uncompressed: number }>): Uint8Array {
  const bytes = workbookBytes()
  const view = new DataView(bytes.buffer)
  const entries = centralEntries(bytes)
  expect(entries.length).toBeGreaterThanOrEqual(sizes.length)
  sizes.forEach((size, index) => {
    view.setUint32(entries[index] + 20, size.compressed, true)
    view.setUint32(entries[index] + 24, size.uncompressed, true)
  })
  return bytes
}

describe('XLSX ZIP expansion preflight', () => {
  it('accepts an ordinary XLSX below the expansion limits', () => {
    expect(() => assertXlsxZipExpansionIsSafe(workbookBytes().buffer as ArrayBuffer)).not.toThrow()
  })

  it('rejects a small archive declaring more than 100 MiB cumulatively', () => {
    const bytes = withCentralSizes([
      { compressed: 600_000, uncompressed: 60 * 1024 * 1024 },
      { compressed: 600_000, uncompressed: 41 * 1024 * 1024 },
    ])
    expect(bytes.byteLength).toBeLessThan(10 * 1024 * 1024)
    expect(() => assertXlsxZipExpansionIsSafe(bytes.buffer as ArrayBuffer)).toThrow(XLSX_EXPANSION_LIMIT_MESSAGE)
  })

  it('rejects an entry whose declared expansion ratio exceeds 100:1', () => {
    const bytes = withCentralSizes([{ compressed: 1, uncompressed: 101 }])
    expect(() => assertXlsxZipExpansionIsSafe(bytes.buffer as ArrayBuffer)).toThrow(XLSX_EXPANSION_LIMIT_MESSAGE)
  })

  it('rejects malformed or unprovable ZIP metadata', () => {
    const bytes = workbookBytes()
    const view = new DataView(bytes.buffer)
    const entry = centralEntries(bytes)[0]
    view.setUint32(entry + 42, 0xffffffff, true)
    expect(() => assertXlsxZipExpansionIsSafe(bytes.buffer as ArrayBuffer)).toThrow(XLSX_EXPANSION_LIMIT_MESSAGE)
  })

  it('rejects adversarial XLSX metadata at both entry points before SheetJS parsing', async () => {
    const bytes = withCentralSizes([{ compressed: 1, uncompressed: MAX_XLSX_UNCOMPRESSED_BYTES + 1 }])
    const read = vi.mocked(XLSX.read)
    read.mockClear()

    await expect(parseTransactionFile(new File([bytes.buffer as ArrayBuffer], 'transactions.xlsx')))
      .rejects.toThrow(XLSX_EXPANSION_LIMIT_MESSAGE)
    await expect(parseValuationFile(new File([bytes.buffer as ArrayBuffer], 'valuations.xlsx')))
      .rejects.toThrow(XLSX_EXPANSION_LIMIT_MESSAGE)
    expect(read).not.toHaveBeenCalled()
  })
})
