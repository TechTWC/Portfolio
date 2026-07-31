import * as XLSX from 'xlsx'

export const MAX_SPREADSHEET_FILE_BYTES = 10 * 1024 * 1024
export const MAX_SPREADSHEET_ROWS = 50_000
export const MAX_SPREADSHEET_ROWS_TO_READ = MAX_SPREADSHEET_ROWS + 2

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
