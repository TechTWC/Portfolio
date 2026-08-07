import { z } from 'zod'
import type { StoredTransaction } from './contracts'
import type { PointInTimeValuation, ValuationMark } from './valuation'
import type { ValuationFreshness } from './valuation-lineage'

export const VALUATION_MARK_TYPES = ['PRICE', 'FX'] as const
export const valuationMarkTypeSchema = z.enum(VALUATION_MARK_TYPES)

export const normalizedValuationMarkSchema = z.object({
  sourceRowNumber: z.number().int().positive(),
  markDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  markType: valuationMarkTypeSchema,
  ticker: z.string().trim().toUpperCase().max(40).default(''),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  value: z.number().finite().positive(),
  source: z.string().trim().max(200).default('UNSPECIFIED'),
  rowHash: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((mark, ctx) => {
  if (mark.markType === 'PRICE' && !mark.ticker) {
    ctx.addIssue({ code: 'custom', path: ['ticker'], message: 'PRICE 標記缺少股票代號' })
  }
})

export const valuationSnapshotUploadSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  transactionDatasetId: z.string().uuid(),
  transactionRevision: z.number().int().positive(),
  valuationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  filename: z.string().min(1).max(255),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  parserVersion: z.string().min(1).max(50),
  sourceRowCount: z.number().int().positive().max(10_000),
  rejectedRowCount: z.number().int().nonnegative().max(10_000),
  marks: z.array(normalizedValuationMarkSchema).min(1).max(10_000),
})

export type NormalizedValuationMark = z.infer<typeof normalizedValuationMarkSchema>
export type ValuationSnapshotUpload = z.infer<typeof valuationSnapshotUploadSchema>

export type ValuationSnapshotSummary = {
  id: string
  revision: number
  status: 'PENDING' | 'ACTIVE' | 'ARCHIVED' | 'REJECTED'
  valuationDate: string
  filename: string
  fileHash: string
  parserVersion: string
  markCount: number
  earliestMarkDate: string | null
  latestMarkDate: string | null
  transactionDatasetId: string
  transactionRevision: number
  createdAt: string
  activatedAt: string | null
}

export type ValuationMarkChangeSample = Pick<
  NormalizedValuationMark,
  'markDate' | 'markType' | 'ticker' | 'currency' | 'value' | 'source' | 'rowHash'
>

export type ValuationSnapshotDiff = {
  unchanged: boolean
  oldMarkCount: number
  newMarkCount: number
  added: number
  removed: number
  unchangedMarks: number
  addedSamples: ValuationMarkChangeSample[]
  removedSamples: ValuationMarkChangeSample[]
}

export type ValuationBootstrapResponse = {
  valuationRevision: number
  currentTransactionDatasetId: string | null
  currentTransactionRevision: number
  freshness: ValuationFreshness
  activeSnapshot: ValuationSnapshotSummary | null
  marks: NormalizedValuationMark[]
  transactions: StoredTransaction[]
  valuation: PointInTimeValuation | null
}

export type ValuationPreviewResponse = {
  diff: ValuationSnapshotDiff
  warnings: string[]
  valuation: PointInTimeValuation
  activationAllowed: boolean
}

export function toValuationMark(mark: NormalizedValuationMark): ValuationMark {
  return {
    sourceRowNumber: mark.sourceRowNumber,
    markDate: mark.markDate,
    markType: mark.markType,
    ticker: mark.ticker,
    currency: mark.currency,
    value: mark.value,
    source: mark.source,
  }
}
