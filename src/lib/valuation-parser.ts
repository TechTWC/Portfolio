import * as XLSX from 'xlsx'
import { sha256Hex, stableTransactionValue } from './hash'
import {
  normalizedValuationMarkSchema,
  type NormalizedValuationMark,
} from './valuation-contracts'
import {
  assertSpreadsheetFileSize,
  assertSpreadsheetRowCount,
  assertWorksheetWasNotTruncated,
  assertXlsxZipExpansionIsSafe,
  isZipContainer,
  MAX_SPREADSHEET_ROWS_TO_READ,
} from './spreadsheet-safety'

export const VALUATION_PARSER_VERSION = 'valuation-v0.3.6'

const COLUMN_ALIASES: Record<string, string[]> = {
  valuationDate: ['估值日', '評價日', '评价日', 'valuation_date', 'valuationdate', 'as_of_date', 'asofdate'],
  markDate: ['標記日期', '标记日期', '價格日期', '价格日期', '匯率日期', '汇率日期', '資料日期', '资料日期', '日期', 'mark_date', 'markdate', 'date'],
  markType: ['類型', '类型', '標記類型', '标记类型', 'mark_type', 'marktype', 'type'],
  ticker: ['股票代號', '股票代码', '代號', '代码', 'ticker', 'symbol', 'stock_id'],
  currency: ['幣別', '币别', 'currency', 'ccy'],
  value: ['數值', '数值', '價格', '价格', '匯率', '汇率', 'value', 'price', 'fx_rate', 'rate', 'close'],
  source: ['來源', '来源', '資料來源', '数据来源', 'source', 'provider'],
}

const TYPE_ALIASES: Record<string, NormalizedValuationMark['markType']> = {
  PRICE: 'PRICE',
  STOCK_PRICE: 'PRICE',
  CLOSE: 'PRICE',
  股價: 'PRICE',
  股票價格: 'PRICE',
  價格: 'PRICE',
  FX: 'FX',
  FX_RATE: 'FX',
  EXCHANGE_RATE: 'FX',
  匯率: 'FX',
  換匯匯率: 'FX',
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replaceAll(' ', '').replaceAll('_', '')
}

function keyFor(row: Record<string, unknown>, canonical: string): unknown {
  const aliases = new Set((COLUMN_ALIASES[canonical] ?? []).map(normalizeHeader))
  for (const [header, value] of Object.entries(row)) {
    if (aliases.has(normalizeHeader(header))) return value
  }
  return undefined
}

function numberValue(value: unknown): number {
  const normalized = String(value ?? '').replaceAll(',', '').replaceAll('，', '').trim()
  const parsed = Number(normalized)
  if (!normalized || !Number.isFinite(parsed)) throw new Error(`無法辨識數值：${normalized || '(空白)'}`)
  return parsed
}

function calendarDateToIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function excelDateToIso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    // Spreadsheet dates are calendar days, not instants in time. Using toISOString()
    // can shift a Taiwan-local midnight to the previous UTC date.
    return calendarDateToIso(value.getFullYear(), value.getMonth() + 1, value.getDate())
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) return calendarDateToIso(parsed.y, parsed.m, parsed.d)
  }
  const raw = String(value ?? '').trim().replaceAll('/', '-')
  const parsed = new Date(`${raw}T00:00:00Z`)
  if (!raw || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error(`無法辨識日期：${raw || '(空白)'}`)
  }
  return raw
}

function normalizeTicker(value: unknown): string {
  const raw = String(value ?? '').trim().toUpperCase()
  if (!raw) return ''
  if (/^\d{4,6}$/.test(raw)) return `${raw}.TW`
  return raw
}

function normalizeType(value: unknown): NormalizedValuationMark['markType'] {
  const raw = String(value ?? '').trim().toUpperCase()
  const markType = TYPE_ALIASES[raw]
  if (!markType) throw new Error(`不支援的估值類型：${raw || '(空白)'}`)
  return markType
}

function inferCurrency(markType: NormalizedValuationMark['markType'], ticker: string, value: unknown): string {
  const explicit = String(value ?? '').trim().toUpperCase()
  if (/^[A-Z]{3}$/.test(explicit)) return explicit
  if (markType === 'FX') throw new Error('FX 標記缺少幣別')
  if (ticker.endsWith('.TW') || ticker.endsWith('.TWO')) return 'TWD'
  return 'USD'
}

async function normalizeRow(row: Record<string, unknown>, index: number): Promise<NormalizedValuationMark> {
  const markType = normalizeType(keyFor(row, 'markType'))
  const ticker = markType === 'PRICE' ? normalizeTicker(keyFor(row, 'ticker')) : ''
  const currency = inferCurrency(markType, ticker, keyFor(row, 'currency'))
  const base = {
    sourceRowNumber: index + 2,
    markDate: excelDateToIso(keyFor(row, 'markDate')),
    markType,
    ticker,
    currency,
    value: numberValue(keyFor(row, 'value')),
    source: String(keyFor(row, 'source') ?? '').trim() || 'MANUAL_UPLOAD',
  }

  const hashInput = [
    base.markDate,
    base.markType,
    base.ticker,
    base.currency,
    base.value,
    base.source,
  ].map(stableTransactionValue).join('|')

  return normalizedValuationMarkSchema.parse({ ...base, rowHash: await sha256Hex(hashInput) })
}

export type ValuationParseResult = {
  fileHash: string
  valuationDate: string
  sourceRowCount: number
  marks: NormalizedValuationMark[]
  rejected: Array<{ sourceRowNumber: number; reason: string }>
  warnings: string[]
}

export async function parseValuationRows(
  rows: Record<string, unknown>[],
  fileHash = '0'.repeat(64),
): Promise<ValuationParseResult> {
  if (rows.length === 0) throw new Error('檔案沒有價格或匯率資料')
  assertSpreadsheetRowCount(rows)

  const valuationDates = new Set<string>()
  for (const row of rows) {
    const raw = keyFor(row, 'valuationDate')
    if (raw !== null && raw !== undefined && String(raw).trim() !== '') valuationDates.add(excelDateToIso(raw))
  }
  if (valuationDates.size === 0) throw new Error('檔案缺少估值日欄位')
  if (valuationDates.size > 1) throw new Error('同一份估值檔只能包含一個估值日')
  const valuationDate = [...valuationDates][0]

  const marks: NormalizedValuationMark[] = []
  const rejected: ValuationParseResult['rejected'] = []
  for (let index = 0; index < rows.length; index += 1) {
    try {
      marks.push(await normalizeRow(rows[index], index))
    } catch (error) {
      rejected.push({
        sourceRowNumber: index + 2,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (marks.length === 0) throw new Error('所有估值資料列都未通過驗證')

  const occurrenceByContentHash = new Map<string, number>()
  let repeatedContentRows = 0
  for (const mark of marks) {
    const contentHash = mark.rowHash
    const occurrence = (occurrenceByContentHash.get(contentHash) ?? 0) + 1
    occurrenceByContentHash.set(contentHash, occurrence)
    if (occurrence > 1) repeatedContentRows += 1
    mark.rowHash = await sha256Hex(`${contentHash}|occurrence:${occurrence}`)
  }

  marks.sort((a, b) =>
    a.markDate.localeCompare(b.markDate)
      || a.markType.localeCompare(b.markType)
      || a.ticker.localeCompare(b.ticker)
      || a.currency.localeCompare(b.currency)
      || a.sourceRowNumber - b.sourceRowNumber,
  )

  const warnings: string[] = []
  if (repeatedContentRows > 0) {
    warnings.push(`${repeatedContentRows} 筆估值標記內容完全相同；系統保留各列，但請確認是否重複匯入`)
  }
  const futureMarks = marks.filter((mark) => mark.markDate > valuationDate).length
  if (futureMarks > 0) warnings.push(`${futureMarks} 筆標記日期晚於估值日，Point-in-Time 引擎將忽略`)

  return { fileHash, valuationDate, sourceRowCount: rows.length, marks, rejected, warnings }
}

export async function parseValuationFile(file: File): Promise<ValuationParseResult> {
  assertSpreadsheetFileSize(file)
  const buffer = await file.arrayBuffer()
  const fileHash = await sha256Hex(buffer)
  if (isZipContainer(buffer)) assertXlsxZipExpansionIsSafe(buffer)
  // Keep spreadsheet calendar dates as raw strings or serial numbers. Converting
  // them to JS Date objects can introduce browser-timezone date shifts.
  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellDates: false,
    sheetRows: MAX_SPREADSHEET_ROWS_TO_READ,
  })
  const firstSheet = workbook.SheetNames[0]
  if (!firstSheet) throw new Error('檔案沒有可讀取的工作表')
  const worksheet = workbook.Sheets[firstSheet]
  assertWorksheetWasNotTruncated(worksheet)
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: '',
    raw: true,
  })
  return parseValuationRows(rows, fileHash)
}
