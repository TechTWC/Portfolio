import type { PositionAccounting } from './accounting'
import type { CashWallet } from './cash-ledger'

const EPSILON = 1e-9

export type ValuationMarkType = 'PRICE' | 'FX'

export type ValuationMark = {
  sourceRowNumber: number
  markDate: string
  markType: ValuationMarkType
  ticker: string
  currency: string
  value: number
  source: string
}

export type ValuationIssueCode =
  | 'INVALID_VALUATION_DATE'
  | 'INVALID_MARK_DATE'
  | 'INVALID_MARK_VALUE'
  | 'MISSING_PRICE'
  | 'MISSING_FX'
  | 'CONFLICTING_MARK'

export type ValuationIssue = {
  code: ValuationIssueCode
  severity: 'BLOCKING'
  message: string
  sourceRowNumbers: number[]
  ticker?: string
  currency?: string
  markDate?: string
}

export type PositionValuation = {
  ticker: string
  currency: string
  quantity: number
  costBasis: number
  price: number | null
  priceDate: string | null
  priceSource: string | null
  marketValueNative: number | null
  unrealizedPnlNative: number | null
  fxRate: number | null
  fxDate: string | null
  fxSource: string | null
  marketValueTwd: number | null
}

export type CashValuation = {
  currency: string
  endingBalance: number
  fxRate: number | null
  fxDate: string | null
  fxSource: string | null
  marketValueTwd: number | null
}

export type PointInTimeValuation = {
  valuationDate: string
  baseCurrency: 'TWD'
  complete: boolean
  positions: PositionValuation[]
  cash: CashValuation[]
  issues: ValuationIssue[]
  blockingIssueCount: number
  futureMarkCount: number
  knownPositionValueTwd: number
  knownCashValueTwd: number
  knownTotalAssetsTwd: number
  totalAssetsTwd: number | null
}

type SelectedMark = ValuationMark

type ValuationInput = {
  valuationDate: string
  positions: PositionAccounting[]
  wallets: CashWallet[]
  marks: ValuationMark[]
}

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function priceKey(ticker: string, currency: string): string {
  return `${ticker.toUpperCase()}\u0000${currency.toUpperCase()}`
}

function fxKey(currency: string): string {
  return currency.toUpperCase()
}

function uniqueNumbers(values: number[]): number[] {
  const output: number[] = []
  for (const value of values) {
    if (!output.some((existing) => Math.abs(existing - value) < EPSILON)) output.push(value)
  }
  return output
}

function selectLatestMarks(
  valuationDate: string,
  marks: ValuationMark[],
  issues: ValuationIssue[],
): {
  prices: Map<string, SelectedMark>
  fx: Map<string, SelectedMark>
  futureMarkCount: number
} {
  const validEligible: ValuationMark[] = []
  let futureMarkCount = 0

  for (const mark of marks) {
    if (!isIsoDate(mark.markDate)) {
      issues.push({
        code: 'INVALID_MARK_DATE',
        severity: 'BLOCKING',
        message: `第 ${mark.sourceRowNumber} 列標記日期不是有效的 YYYY-MM-DD`,
        sourceRowNumbers: [mark.sourceRowNumber],
        ticker: mark.ticker || undefined,
        currency: mark.currency,
        markDate: mark.markDate,
      })
      continue
    }
    if (!Number.isFinite(mark.value) || mark.value <= 0) {
      issues.push({
        code: 'INVALID_MARK_VALUE',
        severity: 'BLOCKING',
        message: `第 ${mark.sourceRowNumber} 列標記值必須大於 0`,
        sourceRowNumbers: [mark.sourceRowNumber],
        ticker: mark.ticker || undefined,
        currency: mark.currency,
        markDate: mark.markDate,
      })
      continue
    }
    if (mark.markDate > valuationDate) {
      futureMarkCount += 1
      continue
    }
    validEligible.push({
      ...mark,
      ticker: mark.ticker.trim().toUpperCase(),
      currency: mark.currency.trim().toUpperCase(),
      source: mark.source.trim() || 'UNSPECIFIED',
    })
  }

  const grouped = new Map<string, ValuationMark[]>()
  for (const mark of validEligible) {
    const key = mark.markType === 'PRICE'
      ? `PRICE\u0000${priceKey(mark.ticker, mark.currency)}`
      : `FX\u0000${fxKey(mark.currency)}`
    const group = grouped.get(key) ?? []
    group.push(mark)
    grouped.set(key, group)
  }

  const prices = new Map<string, SelectedMark>()
  const fx = new Map<string, SelectedMark>()

  for (const [groupKey, group] of grouped) {
    const latestDate = group.reduce((latest, mark) => mark.markDate > latest ? mark.markDate : latest, '')
    const latestMarks = group.filter((mark) => mark.markDate === latestDate)
    const values = uniqueNumbers(latestMarks.map((mark) => mark.value))

    if (values.length > 1) {
      const first = latestMarks[0]
      issues.push({
        code: 'CONFLICTING_MARK',
        severity: 'BLOCKING',
        message: `${first.markType} 在 ${latestDate} 有互相衝突的標記值`,
        sourceRowNumbers: latestMarks.map((mark) => mark.sourceRowNumber).sort((a, b) => a - b),
        ticker: first.ticker || undefined,
        currency: first.currency,
        markDate: latestDate,
      })
      continue
    }

    const selected = [...latestMarks].sort((a, b) =>
      a.source.localeCompare(b.source) || a.sourceRowNumber - b.sourceRowNumber,
    )[0]

    if (groupKey.startsWith('PRICE\u0000')) {
      prices.set(priceKey(selected.ticker, selected.currency), selected)
    } else {
      fx.set(fxKey(selected.currency), selected)
    }
  }

  return { prices, fx, futureMarkCount }
}

function implicitTwdFx(valuationDate: string): SelectedMark {
  return {
    sourceRowNumber: 0,
    markDate: valuationDate,
    markType: 'FX',
    ticker: '',
    currency: 'TWD',
    value: 1,
    source: 'IMPLICIT_TWD_BASE',
  }
}

export function buildPointInTimeValuation(input: ValuationInput): PointInTimeValuation {
  const issues: ValuationIssue[] = []

  if (!isIsoDate(input.valuationDate)) {
    issues.push({
      code: 'INVALID_VALUATION_DATE',
      severity: 'BLOCKING',
      message: '估值日必須是有效的 YYYY-MM-DD',
      sourceRowNumbers: [],
      markDate: input.valuationDate,
    })
  }

  const { prices, fx, futureMarkCount } = selectLatestMarks(input.valuationDate, input.marks, issues)
  fx.set('TWD', implicitTwdFx(input.valuationDate))

  const positions: PositionValuation[] = input.positions
    .filter((position) => position.quantity > EPSILON)
    .map((position) => {
      const ticker = position.ticker.toUpperCase()
      const currency = position.currency.toUpperCase()
      const price = prices.get(priceKey(ticker, currency))
      const fxMark = fx.get(fxKey(currency))

      if (!price) {
        issues.push({
          code: 'MISSING_PRICE',
          severity: 'BLOCKING',
          message: `${ticker} 在 ${input.valuationDate} 或之前沒有可用價格`,
          sourceRowNumbers: [],
          ticker,
          currency,
        })
      }
      if (!fxMark) {
        issues.push({
          code: 'MISSING_FX',
          severity: 'BLOCKING',
          message: `${currency} 在 ${input.valuationDate} 或之前沒有可用匯率`,
          sourceRowNumbers: [],
          ticker,
          currency,
        })
      }

      const marketValueNative = price ? position.quantity * price.value : null
      const unrealizedPnlNative = marketValueNative === null ? null : marketValueNative - position.costBasis
      const marketValueTwd = marketValueNative !== null && fxMark
        ? marketValueNative * fxMark.value
        : null

      return {
        ticker,
        currency,
        quantity: clean(position.quantity),
        costBasis: clean(position.costBasis),
        price: price?.value ?? null,
        priceDate: price?.markDate ?? null,
        priceSource: price?.source ?? null,
        marketValueNative: marketValueNative === null ? null : clean(marketValueNative),
        unrealizedPnlNative: unrealizedPnlNative === null ? null : clean(unrealizedPnlNative),
        fxRate: fxMark?.value ?? null,
        fxDate: fxMark?.markDate ?? null,
        fxSource: fxMark?.source ?? null,
        marketValueTwd: marketValueTwd === null ? null : clean(marketValueTwd),
      }
    })
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.ticker.localeCompare(b.ticker))

  const cash: CashValuation[] = input.wallets
    .map((wallet) => {
      const currency = wallet.currency.toUpperCase()
      const fxMark = fx.get(fxKey(currency))
      const requiresFx = Math.abs(wallet.endingBalance) > EPSILON

      if (requiresFx && !fxMark) {
        issues.push({
          code: 'MISSING_FX',
          severity: 'BLOCKING',
          message: `${currency} 現金在 ${input.valuationDate} 或之前沒有可用匯率`,
          sourceRowNumbers: [],
          currency,
        })
      }

      const marketValueTwd = fxMark ? wallet.endingBalance * fxMark.value : requiresFx ? null : 0
      return {
        currency,
        endingBalance: clean(wallet.endingBalance),
        fxRate: fxMark?.value ?? (requiresFx ? null : 0),
        fxDate: fxMark?.markDate ?? null,
        fxSource: fxMark?.source ?? null,
        marketValueTwd: marketValueTwd === null ? null : clean(marketValueTwd),
      }
    })
    .sort((a, b) => a.currency.localeCompare(b.currency))

  const knownPositionValueTwd = clean(positions.reduce(
    (total, position) => total + (position.marketValueTwd ?? 0),
    0,
  ))
  const knownCashValueTwd = clean(cash.reduce(
    (total, wallet) => total + (wallet.marketValueTwd ?? 0),
    0,
  ))
  const knownTotalAssetsTwd = clean(knownPositionValueTwd + knownCashValueTwd)
  const blockingIssueCount = issues.length
  const complete = blockingIssueCount === 0

  return {
    valuationDate: input.valuationDate,
    baseCurrency: 'TWD',
    complete,
    positions,
    cash,
    issues,
    blockingIssueCount,
    futureMarkCount,
    knownPositionValueTwd,
    knownCashValueTwd,
    knownTotalAssetsTwd,
    totalAssetsTwd: complete ? knownTotalAssetsTwd : null,
  }
}
