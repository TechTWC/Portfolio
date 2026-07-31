import * as XLSX from 'xlsx'

export const MAX_SPREADSHEET_FILE_BYTES = 10 * 1024 * 1024
export const MAX_SPREADSHEET_ROWS = 50_000

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

export function assertWorksheetWasNotTruncated(worksheet: XLSX.WorkSheet): void {
  const cappedRange = worksheet['!ref']
  const originalRange = worksheet['!fullref']
  if (!originalRange || originalRange === cappedRange) return

  let extendsBeyondCap: boolean
  try {
    extendsBeyondCap = !cappedRange
      || XLSX.utils.decode_range(originalRange).e.r > XLSX.utils.decode_range(cappedRange).e.r
  } catch {
    // If SheetJS reports a different original range but it cannot be safely
    // compared with the capped range, do not accept a potentially partial file.
    throw new Error(`${SPREADSHEET_ROW_LIMIT_MESSAGE}；請移除多餘、空白或已格式化的資料列後重試`)
  }

  if (extendsBeyondCap) {
    throw new Error(`${SPREADSHEET_ROW_LIMIT_MESSAGE}；請移除多餘、空白或已格式化的資料列後重試`)
  }
}
