import { z } from 'zod'

export const TRANSACTION_TYPES = [
  'SECURITY',
  'FX_BUY',
  'FX_SELL',
  'CASH_IN',
  'CASH_OUT',
] as const

export const transactionTypeSchema = z.enum(TRANSACTION_TYPES)

export const normalizedTransactionSchema = z.object({
  sourceRowNumber: z.number().int().positive(),
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  transactionType: transactionTypeSchema,
  ticker: z.string().trim().max(40).default(''),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  quantity: z.number().finite().default(0),
  price: z.number().finite().nonnegative().default(0),
  amountForeign: z.number().finite().nonnegative().default(0),
  fxRate: z.number().finite().positive().nullable().default(null),
  fee: z.number().finite().nonnegative().default(0),
  budgetWaterline: z.number().finite().nullable().default(null),
  budgetBalance: z.number().finite().nullable().default(null),
  note: z.string().max(2000).default(''),
  rowHash: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((row, ctx) => {
  if (row.transactionType === 'SECURITY') {
    if (!row.ticker) ctx.addIssue({ code: 'custom', path: ['ticker'], message: '證券交易缺少股票代號' })
    if (row.quantity === 0) ctx.addIssue({ code: 'custom', path: ['quantity'], message: '證券交易股數不得為 0' })
    if (row.price <= 0) ctx.addIssue({ code: 'custom', path: ['price'], message: '證券價格必須大於 0' })
  } else if (row.amountForeign <= 0) {
    ctx.addIssue({ code: 'custom', path: ['amountForeign'], message: `${row.transactionType} 原幣金額必須大於 0` })
  }

  if (
    row.currency !== 'TWD'
    && ['CASH_IN', 'FX_BUY', 'FX_SELL'].includes(row.transactionType)
    && row.fxRate === null
  ) {
    ctx.addIssue({ code: 'custom', path: ['fxRate'], message: `${row.transactionType} 必須提供實際換匯匯率` })
  }
})

export const datasetUploadSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  filename: z.string().min(1).max(255),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  parserVersion: z.string().min(1).max(50),
  sourceRowCount: z.number().int().positive().max(10_000),
  rejectedRowCount: z.number().int().nonnegative().max(10_000),
  transactions: z.array(normalizedTransactionSchema).min(1).max(10_000),
})

export type NormalizedTransaction = z.infer<typeof normalizedTransactionSchema>
export type DatasetUpload = z.infer<typeof datasetUploadSchema>

export type DatasetSummary = {
  id: string
  revision: number
  status: 'PENDING' | 'ACTIVE' | 'ARCHIVED' | 'REJECTED'
  filename: string
  fileHash: string
  parserVersion: string
  rowCount: number
  earliestDate: string | null
  latestDate: string | null
  createdAt: string
  activatedAt: string | null
}

export type BootstrapResponse = {
  user: { id: string; email: string }
  cloudRevision: number
  activeDataset: DatasetSummary | null
  transactions: NormalizedTransaction[]
}

export type TransactionChangeSample = Pick<
  NormalizedTransaction,
  'tradeDate' | 'transactionType' | 'ticker' | 'currency' | 'quantity' | 'price' | 'amountForeign' | 'rowHash'
>

export type DatasetDiff = {
  unchanged: boolean
  oldRowCount: number
  newRowCount: number
  added: number
  removed: number
  unchangedRows: number
  earliestDate: string | null
  latestDate: string | null
  addedSamples: TransactionChangeSample[]
  removedSamples: TransactionChangeSample[]
}
