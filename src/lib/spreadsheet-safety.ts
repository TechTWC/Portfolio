export const MAX_SPREADSHEET_FILE_BYTES = 10 * 1024 * 1024
export const MAX_SPREADSHEET_ROWS = 50_000

export function assertSpreadsheetFileSize(file: File): void {
  if (file.size > MAX_SPREADSHEET_FILE_BYTES) {
    throw new Error('試算表檔案過大；上限為 10 MB')
  }
}

export function assertSpreadsheetRowCount(rows: unknown[]): void {
  if (rows.length > MAX_SPREADSHEET_ROWS) {
    throw new Error(`試算表資料列過多；上限為 ${MAX_SPREADSHEET_ROWS.toLocaleString('en-US')} 列`)
  }
}
