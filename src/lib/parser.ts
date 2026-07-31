import * as XLSX from 'xlsx'
import type { NormalizedTransaction } from './contracts'
import { normalizedTransactionSchema } from './contracts'
import { sha256Hex, stableTransactionValue } from './hash'
import {
  assertSpreadsheetFileSize,
  assertSpreadsheetRowCount,
  assertWorksheetWasNotTruncated,
  MAX_SPREADSHEET_ROWS_TO_READ,
} from './spreadsheet-safety'

export const PARSER_VERSION = 'cloud-v0.1.3'

const INVALID_EXCEL_FILE_MESSAGE = 'Excel 檔案損壞或副檔名與格式不符；請確認檔案可正常開啟後重新上傳'

const COLUMN_ALIASES: Record<string, string[]> = {
  tradeDate: ['日期', '交易日期', 'date', 'datetime', 'trade_date'],
  transactionType: ['交易類型', '交易类型', 'type', 'trade_type', 'transaction_type'],
  ticker: ['股票代號', '股票代码', '代號', 'ticker', 'symbol', 'stock_id'],
  quantity: ['購買股數', '股數', '数量', 'quantity', 'shares', 'qty'],
  price: ['購買股價', '股價', '价格', 'price', 'trade_price', 'purchase_price'],
  amountForeign: ['原幣金額', '金额', 'amount_foreign', 'foreign_amount', 'cash_amount', 'amount'],
  fxRate: ['換匯匯率', '匯率', '汇率', 'fx_rate', 'fx', 'exchange_rate'],
  fee: ['交易成本', '手續費', '手续费', '買賣手續費', 'fee', 'fees', 'commission', 'transaction_fee'],
  currency: ['幣別', '交易幣別', '币别', 'currency', 'ccy', 'trade_currency', 'transaction_currency'],
  budgetWaterline: ['投資預算總水位', 'budget_waterline', 'budget_total', 'portfolio_budget'],
  budgetBalance: ['預算餘額', 'budget_balance', 'cash_balance', 'cash'],
  note: ['備註', '备注', 'note', 'memo', 'remark'],
}

const TYPE_ALIASES: Record<string, NormalizedTransaction['transactionType']> = {
  SECURITY: 'SECURITY',
  BUY: 'SECURITY',
  SELL: 'SECURITY',
  證券: 'SECURITY',
  股票: 'SECURITY',
  STOCK: 'SECURITY',
  STOCK_TRADE: 'SECURITY',
  SECURITY_TRADE: 'SECURITY',
  TRADE: 'SECURITY',
  FX_BUY: 'FX_BUY',
  BUY_FX: 'FX_BUY',
  FOREX_BUY: 'FX_BUY',
  換匯買入: 'FX_BUY',
  買入外幣: 'FX_BUY',
  FX_SELL: 'FX_SELL',
  SELL_FX: 'FX_SELL',
  FOREX_SELL: 'FX_SELL',
  換匯賣出: 'FX_SELL',
  賣出外幣: 'FX_SELL',
  CASH_IN: 'CASH_IN',
  DEPOSIT: 'CASH_IN',
  INFLOW: 'CASH_IN',
  入金: 'CASH_IN',
  CASH_OUT: 'CASH_OUT',
  WITHDRAWAL: 'CASH_OUT',
  OUTFLOW: 'CASH_OUT',
  出金: 'CASH_OUT',
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replaceAll(' ', '').replaceAll('_', '')
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value)
}

function assertExcelContainerMatchesExtension(file: File, buffer: ArrayBuffer): void {
  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1]
  const bytes = new Uint8Array(buffer)

  if (extension === 'xlsx' && !hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    throw new Error(INVALID_EXCEL_FILE_MESSAGE)
  }

  if (extension === 'xls') {
    const isCompoundBinary = hasPrefix(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    const isRawBiff = bytes[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(bytes[1])
    if (!isCompoundBinary && !isRawBiff) throw new Error(INVALID_EXCEL_FILE_MESSAGE)
  }
}

function keyFor(row: Record<string, unknown>, canonical: string): unknown {
  const aliases = new Set((COLUMN_ALIASES[canonical] ?? []).map(normalizeHeader))
  for (const [header, value] of Object.entries(row)) {
    if (aliases.has(normalizeHeader(header))) return value
  }
  return undefined
}

function numberValue(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback
  const normalized = String(value).replaceAll(',', '').replaceAll('，', '').trim()
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : fallback
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = numberValue(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : null
}

function excelDateToIso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) {
      return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`
    }
  }
  const raw = String(value ?? '').trim().replaceAll('/', '-')
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.valueOf())) throw new Error(`無法辨識日期：${raw || '(空白)'}`)
  return parsed.toISOString().slice(0, 10)
}

function normalizeTicker(value: unknown): string {
  const raw = String(value ?? '').trim().toUpperCase()
  if (!raw) return ''
  if (/^\d{4,6}$/.test(raw)) return `${raw}.TW`
  return raw
}

function inferCurrency(ticker: string, rawCurrency: unknown): string {
  const explicit = String(rawCurrency ?? '').trim().toUpperCase()
  if (/^[A-Z]{3}$/.test(explicit)) return explicit
  if (ticker.endsWith('.TW') || ticker.endsWith('.TWO')) return 'TWD'
  return 'USD'
}

function normalizeTypeAndQuantity(
  value: unknown,
  inputQuantity: number,
): { transactionType: NormalizedTransaction['transactionType']; quantity: number } {
  const raw = String(value ?? 'SECURITY').trim().toUpperCase()
  const transactionType = TYPE_ALIASES[raw] ?? (!raw && inputQuantity !== 0 ? 'SECURITY' : undefined)
  if (!transactionType) throw new Error(`不支援的交易類型：${raw}`)
  if (raw === 'SELL' && inputQuantity > 0) return { transactionType, quantity: -inputQuantity }
  if (raw === 'BUY' && inputQuantity < 0) return { transactionType, quantity: Math.abs(inputQuantity) }
  return { transactionType, quantity: inputQuantity }
}

async function normalizeRow(row: Record<string, unknown>, index: number): Promise<NormalizedTransaction> {
  const inputQuantity = numberValue(keyFor(row, 'quantity'))
  const { transactionType, quantity } = normalizeTypeAndQuantity(
    keyFor(row, 'transactionType'),
    inputQuantity,
  )
  const ticker = normalizeTicker(keyFor(row, 'ticker'))
  const currency = inferCurrency(ticker, keyFor(row, 'currency'))
  const fxRateRaw = nullableNumber(keyFor(row, 'fxRate'))
  const fxRate = currency === 'TWD' ? 1 : fxRateRaw

  const price = numberValue(keyFor(row, 'price'))
  const explicitAmount = nullableNumber(keyFor(row, 'amountForeign'))
  const amountForeign = transactionType === 'SECURITY'
    ? Math.abs(explicitAmount ?? price * quantity)
    : Math.abs(explicitAmount ?? 0)

  const base = {
    sourceRowNumber: index + 2,
    tradeDate: excelDateToIso(keyFor(row, 'tradeDate')),
    transactionType,
    ticker,
    currency,
    quantity,
    price,
    amountForeign,
    fxRate,
    fee: Math.abs(numberValue(keyFor(row, 'fee'))),
    budgetWaterline: nullableNumber(keyFor(row, 'budgetWaterline')),
    budgetBalance: nullableNumber(keyFor(row, 'budgetBalance')),
    note: String(keyFor(row, 'note') ?? '').trim(),
  }

  if (transactionType === 'SECURITY') {
    if (!ticker) throw new Error(`第 ${index + 2} 列缺少股票代號`)
    if (quantity === 0) throw new Error(`第 ${index + 2} 列證券交易股數不得為 0`)
    if (base.price <= 0) throw new Error(`第 ${index + 2} 列證券價格必須大於 0`)
  } else if (base.amountForeign <= 0) {
    throw new Error(`第 ${index + 2} 列 ${transactionType} 原幣金額必須大於 0`)
  }

  if (
    currency !== 'TWD'
    && ['CASH_IN', 'FX_BUY', 'FX_SELL'].includes(transactionType)
    && (fxRate === null || fxRate <= 0)
  ) {
    throw new Error(`第 ${index + 2} 列 ${transactionType} 必須提供實際換匯匯率`)
  }

  const hashInput = [
    base.tradeDate,
    base.transactionType,
    base.ticker,
    base.currency,
    base.quantity,
    base.price,
    base.amountForeign,
    base.fxRate,
    base.fee,
    base.budgetWaterline,
    base.budgetBalance,
    base.note,
  ].map(stableTransactionValue).join('|')

  return normalizedTransactionSchema.parse({ ...base, rowHash: await sha256Hex(hashInput) })
}

export type ParseResult = {
  fileHash: string
  sourceRowCount: number
  transactions: NormalizedTransaction[]
  rejected: Array<{ sourceRowNumber: number; reason: string }>
  warnings: string[]
}

export async function parseTransactionRows(
  rows: Record<string, unknown>[],
  fileHash = '0'.repeat(64),
): Promise<ParseResult> {
  if (rows.length === 0) throw new Error('檔案沒有交易資料')
  assertSpreadsheetRowCount(rows)

  const transactions: NormalizedTransaction[] = []
  const rejected: ParseResult['rejected'] = []
  for (let index = 0; index < rows.length; index += 1) {
    try {
      transactions.push(await normalizeRow(rows[index], index))
    } catch (error) {
      rejected.push({
        sourceRowNumber: index + 2,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Identical economic rows may be legitimate repeated fills. Preserve every
  // occurrence while still giving D1 a unique and cross-version-stable row hash.
  const occurrenceByContentHash = new Map<string, number>()
  let repeatedContentRows = 0
  for (const row of transactions) {
    const contentHash = row.rowHash
    const occurrence = (occurrenceByContentHash.get(contentHash) ?? 0) + 1
    occurrenceByContentHash.set(contentHash, occurrence)
    if (occurrence > 1) repeatedContentRows += 1
    row.rowHash = await sha256Hex(`${contentHash}|occurrence:${occurrence}`)
  }

  transactions.sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber,
  )

  const warnings: string[] = []
  if (repeatedContentRows > 0) {
    warnings.push(`${repeatedContentRows} 筆交易內容與其他列完全相同；系統保留為獨立成交，請人工確認是否為重複匯入`)
  }
  const missingFx = transactions.filter(
    (row) => row.currency !== 'TWD'
      && row.fxRate === null
      && ['SECURITY', 'CASH_OUT'].includes(row.transactionType),
  )
  if (missingFx.length > 0) warnings.push(`${missingFx.length} 筆外幣證券／出金交易缺少輸入匯率，後續分析需市場匯率 fallback`)

  if (transactions.length === 0) throw new Error('所有資料列都未通過驗證')
  return { fileHash, sourceRowCount: rows.length, transactions, rejected, warnings }
}

export async function parseTransactionFile(file: File): Promise<ParseResult> {
  assertSpreadsheetFileSize(file)
  const buffer = await file.arrayBuffer()
  const fileHash = await sha256Hex(buffer)
  assertExcelContainerMatchesExtension(file, buffer)
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(buffer, {
      type: 'array',
      cellDates: true,
      sheetRows: MAX_SPREADSHEET_ROWS_TO_READ,
    })
  } catch {
    throw new Error(INVALID_EXCEL_FILE_MESSAGE)
  }
  const firstSheet = workbook.SheetNames[0]
  if (!firstSheet) throw new Error(INVALID_EXCEL_FILE_MESSAGE)
  const worksheet = workbook.Sheets[firstSheet]
  assertWorksheetWasNotTruncated(worksheet)
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: '',
    raw: true,
  })
  return parseTransactionRows(rows, fileHash)
}
