import type { NormalizedTransaction } from './contracts'

const EPSILON = 1e-9

export type AccountingIssueCode = 'OVERSELL' | 'CURRENCY_MISMATCH'

export type AccountingIssue = {
  code: AccountingIssueCode
  severity: 'BLOCKING' | 'WARNING'
  sourceRowNumber: number
  tradeDate: string
  ticker: string
  currency: string
  message: string
}

export type PositionAccounting = {
  ticker: string
  currency: string
  quantity: number
  costBasis: number
  averageUnitCost: number
  realizedPnl: number
  grossBuys: number
  grossSells: number
  fees: number
  tradeCount: number
}

export type CurrencyAccounting = {
  currency: string
  grossBuys: number
  grossSells: number
  fees: number
  netSecurityCashFlow: number
  realizedPnl: number
}

export type PortfolioAccounting = {
  positions: PositionAccounting[]
  currencies: CurrencyAccounting[]
  issues: AccountingIssue[]
  blockingIssueCount: number
  securityTransactionCount: number
  deferredTransactionCount: number
}

type MutablePosition = Omit<PositionAccounting, 'averageUnitCost'>

function positionKey(ticker: string, currency: string): string {
  return `${ticker}\u0000${currency}`
}

function emptyCurrency(currency: string): CurrencyAccounting {
  return {
    currency,
    grossBuys: 0,
    grossSells: 0,
    fees: 0,
    netSecurityCashFlow: 0,
    realizedPnl: 0,
  }
}

function emptyPosition(ticker: string, currency: string): MutablePosition {
  return {
    ticker,
    currency,
    quantity: 0,
    costBasis: 0,
    realizedPnl: 0,
    grossBuys: 0,
    grossSells: 0,
    fees: 0,
    tradeCount: 0,
  }
}

function cleanZero(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

export function buildPortfolioAccounting(transactions: NormalizedTransaction[]): PortfolioAccounting {
  const ordered = [...transactions].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber,
  )
  const positions = new Map<string, MutablePosition>()
  const currencies = new Map<string, CurrencyAccounting>()
  const tickerCurrency = new Map<string, string>()
  const issues: AccountingIssue[] = []
  let securityTransactionCount = 0
  let deferredTransactionCount = 0

  for (const row of ordered) {
    if (row.transactionType !== 'SECURITY') {
      // CASH and FX rows are handled by cash-ledger v0.2. The security
      // accounting module deliberately ignores them without producing a stale
      // warning that would contradict the dedicated cash-funding panel.
      deferredTransactionCount += 1
      continue
    }

    securityTransactionCount += 1
    const existingCurrency = tickerCurrency.get(row.ticker)
    if (existingCurrency && existingCurrency !== row.currency) {
      issues.push({
        code: 'CURRENCY_MISMATCH',
        severity: 'BLOCKING',
        sourceRowNumber: row.sourceRowNumber,
        tradeDate: row.tradeDate,
        ticker: row.ticker,
        currency: row.currency,
        message: `${row.ticker} 先前使用 ${existingCurrency}，本列卻使用 ${row.currency}`,
      })
      continue
    }
    tickerCurrency.set(row.ticker, row.currency)

    const key = positionKey(row.ticker, row.currency)
    const position = positions.get(key) ?? emptyPosition(row.ticker, row.currency)
    const currency = currencies.get(row.currency) ?? emptyCurrency(row.currency)
    const amount = row.amountForeign > 0 ? row.amountForeign : Math.abs(row.quantity) * row.price

    if (row.quantity > 0) {
      const totalCost = amount + row.fee
      position.quantity += row.quantity
      position.costBasis += totalCost
      position.grossBuys += amount
      position.fees += row.fee
      position.tradeCount += 1

      currency.grossBuys += amount
      currency.fees += row.fee
      currency.netSecurityCashFlow -= totalCost
    } else {
      const sellQuantity = Math.abs(row.quantity)
      if (sellQuantity > position.quantity + EPSILON) {
        issues.push({
          code: 'OVERSELL',
          severity: 'BLOCKING',
          sourceRowNumber: row.sourceRowNumber,
          tradeDate: row.tradeDate,
          ticker: row.ticker,
          currency: row.currency,
          message: `${row.ticker} 欲賣出 ${sellQuantity} 股，但當時僅持有 ${position.quantity} 股`,
        })
        positions.set(key, position)
        currencies.set(row.currency, currency)
        continue
      }

      const averageUnitCost = position.quantity > EPSILON ? position.costBasis / position.quantity : 0
      const releasedCostBasis = averageUnitCost * sellQuantity
      const netSaleProceeds = amount - row.fee
      const realizedPnl = netSaleProceeds - releasedCostBasis

      position.quantity = cleanZero(position.quantity - sellQuantity)
      position.costBasis = cleanZero(position.costBasis - releasedCostBasis)
      position.realizedPnl += realizedPnl
      position.grossSells += amount
      position.fees += row.fee
      position.tradeCount += 1

      currency.grossSells += amount
      currency.fees += row.fee
      currency.netSecurityCashFlow += netSaleProceeds
      currency.realizedPnl += realizedPnl
    }

    positions.set(key, position)
    currencies.set(row.currency, currency)
  }

  const positionOutput = [...positions.values()]
    .map((position): PositionAccounting => ({
      ...position,
      quantity: cleanZero(position.quantity),
      costBasis: cleanZero(position.costBasis),
      averageUnitCost: position.quantity > EPSILON ? position.costBasis / position.quantity : 0,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.ticker.localeCompare(b.ticker))

  const currencyOutput = [...currencies.values()]
    .map((currency) => ({
      ...currency,
      netSecurityCashFlow: cleanZero(currency.netSecurityCashFlow),
      realizedPnl: cleanZero(currency.realizedPnl),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency))

  return {
    positions: positionOutput,
    currencies: currencyOutput,
    issues,
    blockingIssueCount: issues.filter((issue) => issue.severity === 'BLOCKING').length,
    securityTransactionCount,
    deferredTransactionCount,
  }
}
