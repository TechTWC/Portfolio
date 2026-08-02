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
    ['日期', '交易類型', '股票代號', '購買股數', '購買股價', '幣別', '估值日', '類型', '數值'],
    ['2026-01-02', 'BUY', '2330', 1, 100, 'TWD', '2026-01-02', 'PRICE', 100],
  ]), 'Sheet1')
  return new Uint8Array(XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true }))
}

function withDataDescriptors(includeSignature: boolean): Uint8Array {
  const original = workbookBytes()
  const originalView = new DataView(original.buffer)
  const entries = centralEntries(original).map((centralOffset) => ({
    centralOffset,
    localOffset: originalView.getUint32(centralOffset + 42, true),
    crc: originalView.getUint32(centralOffset + 16, true),
    compressed: originalView.getUint32(centralOffset + 20, true),
    uncompressed: originalView.getUint32(centralOffset + 24, true),
  })).sort((a, b) => a.localOffset - b.localOffset)
  const oldCentralOffset = entries[0].centralOffset
  const descriptorLength = includeSignature ? 16 : 12
  const output = new Uint8Array(original.length + entries.length * descriptorLength)
  let sourceOffset = 0
  let outputOffset = 0
  const shiftedLocalOffsets = new Map<number, number>()

  for (const entry of entries) {
    const nameLength = originalView.getUint16(entry.localOffset + 26, true)
    const extraLength = originalView.getUint16(entry.localOffset + 28, true)
    const dataEnd = entry.localOffset + 30 + nameLength + extraLength + entry.compressed
    output.set(original.subarray(sourceOffset, dataEnd), outputOffset)
    shiftedLocalOffsets.set(entry.localOffset, entry.localOffset + outputOffset - sourceOffset)
    outputOffset += dataEnd - sourceOffset
    const descriptor = new DataView(output.buffer, outputOffset, descriptorLength)
    let fieldOffset = 0
    if (includeSignature) {
      descriptor.setUint32(0, 0x08074b50, true)
      fieldOffset = 4
    }
    descriptor.setUint32(fieldOffset, entry.crc, true)
    descriptor.setUint32(fieldOffset + 4, entry.compressed, true)
    descriptor.setUint32(fieldOffset + 8, entry.uncompressed, true)
    outputOffset += descriptorLength
    sourceOffset = dataEnd
  }
  output.set(original.subarray(sourceOffset), outputOffset)

  const delta = entries.length * descriptorLength
  const view = new DataView(output.buffer)
  for (const entry of entries) {
    const localOffset = shiftedLocalOffsets.get(entry.localOffset)!
    view.setUint16(localOffset + 6, originalView.getUint16(entry.localOffset + 6, true) | 0x0008, true)
    view.setUint32(localOffset + 14, 0, true)
    view.setUint32(localOffset + 18, 0, true)
    view.setUint32(localOffset + 22, 0, true)
    const centralOffset = entry.centralOffset + delta
    view.setUint16(centralOffset + 8, originalView.getUint16(entry.centralOffset + 8, true) | 0x0008, true)
    view.setUint32(centralOffset + 42, localOffset, true)
  }
  const eocdOffset = output.length - 22
  view.setUint32(eocdOffset + 16, oldCentralOffset + delta, true)
  return output
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

  it('preflights ZIP bytes renamed as CSV at both entry points before SheetJS parsing', async () => {
    const bytes = withCentralSizes([{ compressed: 1, uncompressed: MAX_XLSX_UNCOMPRESSED_BYTES + 1 }])
    const read = vi.mocked(XLSX.read)
    read.mockClear()

    await expect(parseTransactionFile(new File([bytes.buffer as ArrayBuffer], 'transactions.csv')))
      .rejects.toThrow(XLSX_EXPANSION_LIMIT_MESSAGE)
    await expect(parseValuationFile(new File([bytes.buffer as ArrayBuffer], 'valuations.csv')))
      .rejects.toThrow(XLSX_EXPANSION_LIMIT_MESSAGE)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([true, false])('accepts a valid bit-3 XLSX descriptor (signature: %s)', async (includeSignature) => {
    const bytes = withDataDescriptors(includeSignature)
    expect(() => assertXlsxZipExpansionIsSafe(bytes.buffer as ArrayBuffer)).not.toThrow()
    await expect(parseTransactionFile(new File([bytes.buffer as ArrayBuffer], 'transactions.xlsx')))
      .resolves.toMatchObject({ sourceRowCount: 1, transactions: [{ ticker: '2330.TW' }] })
    await expect(parseValuationFile(new File([bytes.buffer as ArrayBuffer], 'valuations.xlsx')))
      .resolves.toMatchObject({ sourceRowCount: 1, marks: [{ ticker: '2330.TW' }] })
  })

  it('rejects a tampered data descriptor', () => {
    const bytes = withDataDescriptors(true)
    const view = new DataView(bytes.buffer)
    const firstCentral = centralEntries(bytes)[0]
    const localOffset = view.getUint32(firstCentral + 42, true)
    const dataEnd = localOffset + 30 + view.getUint16(localOffset + 26, true)
      + view.getUint16(localOffset + 28, true) + view.getUint32(firstCentral + 20, true)
    view.setUint32(dataEnd + 4, view.getUint32(dataEnd + 4, true) ^ 1, true)
    expect(() => assertXlsxZipExpansionIsSafe(bytes.buffer as ArrayBuffer)).toThrow(XLSX_EXPANSION_LIMIT_MESSAGE)
  })

  it('rejects inconsistent bit-3 local and central metadata', () => {
    const bytes = withDataDescriptors(false)
    const view = new DataView(bytes.buffer)
    const firstCentral = centralEntries(bytes)[0]
    const localOffset = view.getUint32(firstCentral + 42, true)
    view.setUint32(localOffset + 18, view.getUint32(firstCentral + 20, true) + 1, true)
    expect(() => assertXlsxZipExpansionIsSafe(bytes.buffer as ArrayBuffer)).toThrow(XLSX_EXPANSION_LIMIT_MESSAGE)
  })
})
