import * as XLSX from 'xlsx'

export const MAX_SPREADSHEET_FILE_BYTES = 10 * 1024 * 1024
export const MAX_SPREADSHEET_ROWS = 50_000
export const MAX_SPREADSHEET_ROWS_TO_READ = MAX_SPREADSHEET_ROWS + 2
export const MAX_XLSX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
export const MAX_XLSX_COMPRESSION_RATIO = 100

export const XLSX_EXPANSION_LIMIT_MESSAGE = 'Excel 檔案無法安全開啟；請確認檔案內容與壓縮格式後重試'

const SPREADSHEET_ROW_LIMIT_MESSAGE = `試算表資料列過多；上限為 ${MAX_SPREADSHEET_ROWS.toLocaleString('en-US')} 列`

export function assertSpreadsheetFileSize(file: File): void {
  if (file.size > MAX_SPREADSHEET_FILE_BYTES) {
    throw new Error('試算表檔案過大；上限為 10 MB')
  }
}

export function assertSpreadsheetRowCount(rows: unknown[]): void {
  if (rows.length > MAX_SPREADSHEET_ROWS) {
    throw new Error(SPREADSHEET_ROW_LIMIT_MESSAGE)
  }
}

function xlsxSafetyError(): Error {
  return new Error(XLSX_EXPANSION_LIMIT_MESSAGE)
}

function readUint16(view: DataView, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 2 > view.byteLength) throw xlsxSafetyError()
  return view.getUint16(offset, true)
}

function readUint32(view: DataView, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > view.byteLength) throw xlsxSafetyError()
  return view.getUint32(offset, true)
}

/** Detect containers that SheetJS will treat as ZIPs, independent of their filename. */
export function isZipContainer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false
  const signature = new DataView(buffer).getUint32(0, true)
  return signature === 0x04034b50 || signature === 0x06054b50 || signature === 0x08074b50
}

/** Validate a classic, unencrypted XLSX ZIP using metadata only; no member is inflated. */
export function assertXlsxZipExpansionIsSafe(buffer: ArrayBuffer): void {
  const view = new DataView(buffer)
  const minimumEocdOffset = Math.max(0, view.byteLength - 65_557)
  let eocdOffset = -1
  for (let offset = view.byteLength - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (readUint32(view, offset) === 0x06054b50) {
      const commentLength = readUint16(view, offset + 20)
      if (offset + 22 + commentLength === view.byteLength) {
        eocdOffset = offset
        break
      }
    }
  }
  if (eocdOffset < 0) throw xlsxSafetyError()

  const disk = readUint16(view, eocdOffset + 4)
  const centralDisk = readUint16(view, eocdOffset + 6)
  const entriesOnDisk = readUint16(view, eocdOffset + 8)
  const entryCount = readUint16(view, eocdOffset + 10)
  const centralSize = readUint32(view, eocdOffset + 12)
  const centralOffset = readUint32(view, eocdOffset + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0
    || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize !== eocdOffset) throw xlsxSafetyError()

  let offset = centralOffset
  let totalCompressed = 0
  let totalUncompressed = 0
  const entries: Array<{
    compressed: number
    uncompressed: number
    crc: number
    flags: number
    localOffset: number
    method: number
    nameOffset: number
    nameLength: number
  }> = []
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(view, offset) !== 0x02014b50) throw xlsxSafetyError()
    const flags = readUint16(view, offset + 8)
    const method = readUint16(view, offset + 10)
    const crc = readUint32(view, offset + 16)
    const compressed = readUint32(view, offset + 20)
    const uncompressed = readUint32(view, offset + 24)
    const nameLength = readUint16(view, offset + 28)
    const extraLength = readUint16(view, offset + 30)
    const commentLength = readUint16(view, offset + 32)
    const startDisk = readUint16(view, offset + 34)
    const localOffset = readUint32(view, offset + 42)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if ((flags & 0x0001) !== 0 || startDisk !== 0 || compressed === 0xffffffff
      || uncompressed === 0xffffffff || localOffset === 0xffffffff || nextOffset > eocdOffset) throw xlsxSafetyError()
    if (uncompressed > 0 && compressed === 0) throw xlsxSafetyError()
    if (compressed > 0 && uncompressed / compressed > MAX_XLSX_COMPRESSION_RATIO) throw xlsxSafetyError()
    totalCompressed += compressed
    totalUncompressed += uncompressed
    if (!Number.isSafeInteger(totalCompressed) || !Number.isSafeInteger(totalUncompressed)
      || totalUncompressed > MAX_XLSX_UNCOMPRESSED_BYTES) throw xlsxSafetyError()
    entries.push({ compressed, uncompressed, crc, flags, localOffset, method, nameOffset: offset + 46, nameLength })
    offset = nextOffset
  }
  if (offset !== eocdOffset || totalCompressed === 0
    || totalUncompressed / totalCompressed > MAX_XLSX_COMPRESSION_RATIO) throw xlsxSafetyError()

  const ranges: Array<[number, number]> = []
  for (const entry of entries) {
    if (readUint32(view, entry.localOffset) !== 0x04034b50
      || readUint16(view, entry.localOffset + 6) !== entry.flags
      || readUint16(view, entry.localOffset + 8) !== entry.method) throw xlsxSafetyError()
    const usesDescriptor = (entry.flags & 0x0008) !== 0
    const localCrc = readUint32(view, entry.localOffset + 14)
    const localCompressed = readUint32(view, entry.localOffset + 18)
    const localUncompressed = readUint32(view, entry.localOffset + 22)
    if (usesDescriptor) {
      if ((localCrc !== 0 && localCrc !== entry.crc)
        || (localCompressed !== 0 && localCompressed !== entry.compressed)
        || (localUncompressed !== 0 && localUncompressed !== entry.uncompressed)) throw xlsxSafetyError()
    } else if (localCrc !== entry.crc || localCompressed !== entry.compressed
      || localUncompressed !== entry.uncompressed) throw xlsxSafetyError()
    const nameLength = readUint16(view, entry.localOffset + 26)
    const extraLength = readUint16(view, entry.localOffset + 28)
    if (nameLength !== entry.nameLength) throw xlsxSafetyError()
    for (let index = 0; index < nameLength; index += 1) {
      if (view.getUint8(entry.localOffset + 30 + index) !== view.getUint8(entry.nameOffset + index)) throw xlsxSafetyError()
    }
    const dataStart = entry.localOffset + 30 + nameLength + extraLength
    const dataEnd = dataStart + entry.compressed
    if (!Number.isSafeInteger(dataEnd) || dataEnd > centralOffset) throw xlsxSafetyError()
    let memberEnd = dataEnd
    if (usesDescriptor) {
      const descriptorMatches = (descriptorOffset: number) => readUint32(view, descriptorOffset) === entry.crc
        && readUint32(view, descriptorOffset + 4) === entry.compressed
        && readUint32(view, descriptorOffset + 8) === entry.uncompressed
      if (readUint32(view, dataEnd) === 0x08074b50 && descriptorMatches(dataEnd + 4)) {
        memberEnd = dataEnd + 16
      } else if (descriptorMatches(dataEnd)) {
        memberEnd = dataEnd + 12
      } else {
        throw xlsxSafetyError()
      }
      if (memberEnd > centralOffset) throw xlsxSafetyError()
    }
    ranges.push([entry.localOffset, memberEnd])
  }
  ranges.sort((a, b) => a[0] - b[0])
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) throw xlsxSafetyError()
}

function spreadsheetRowLimitError(): Error {
  return new Error(`${SPREADSHEET_ROW_LIMIT_MESSAGE}；請移除多餘、空白或已格式化的資料列後重試`)
}

export function assertWorksheetWasNotTruncated(worksheet: XLSX.WorkSheet): void {
  const cappedRange = worksheet['!ref']
  const originalRange = worksheet['!fullref']
  if (!cappedRange && !originalRange) return

  let cappedEndRow: number
  try {
    cappedEndRow = cappedRange ? XLSX.utils.decode_range(cappedRange).e.r : -1
  } catch {
    throw spreadsheetRowLimitError()
  }

  if (!originalRange) {
    // SheetJS 0.20.3 does not expose !fullref for capped CSV input. Reaching
    // sheetRows means the parser cannot prove that no later record was omitted.
    if (cappedEndRow + 1 >= MAX_SPREADSHEET_ROWS_TO_READ) {
      throw spreadsheetRowLimitError()
    }
    return
  }

  if (originalRange === cappedRange) return

  let originalEndRow: number
  try {
    originalEndRow = XLSX.utils.decode_range(originalRange).e.r
  } catch {
    throw spreadsheetRowLimitError()
  }

  if (!cappedRange || originalEndRow > cappedEndRow) {
    throw spreadsheetRowLimitError()
  }
}
