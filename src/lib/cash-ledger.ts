import type { NormalizedTransaction } from './contracts'

export type CashTrackingMode = 'UNTRACKED' | 'TRACKED'

export type CashLedgerIssueCode =
  | 'NEGATIVE_NET_CASH_IN'
  | 'CASH_OUT_EXCEEDS_BALANCE'
  | 'INVALID_FX_CURRENCY'
  | 'MISSING_FX_RATE'
  | 'INSUFFICIENT_TWD_FOR_FX_BUY'
  | 'FX_SELL_EXCEEDS_BALANCE'
  | 'NEGATIVE_NET_FX_PROCEEDS'
  | 'MISSING_FX_RATE_FOR_AUTO_FUND'
  | 'INSUFFICIENT_TWD_FOR_AUTO_FUND'
  | 'INSUFFICIENT_CASH_FOR_SECURITY_BUY'
  | 'NEGATIVE_NET_SECURITY_PROCEEDS'

export type CashLedgerIssue = {
  code: CashLedgerIssueCode
  severity: 'BLOCKING'
  sourceRowNumber: number
  tradeDate: string
  currency: string
  message: string
  required?: number
  available?: number
}

export type CashWallet = {
  currency: string
  deposits: number
  withdrawals: number
  explicitFxIn: number
  explicitFxOut: number
  autoFundedIn: number
  autoFundingOut: number
  securitySpent: number
  securityReceived: number
  fees: number
  endingBalance: number
}

export type CashLedgerResult = {
  trackingMode: CashTrackingMode
  wallets: CashWallet[]
  issues: CashLedgerIssue[]
  blockingIssueCount: number
}

type MutableWallet = CashWallet

const EPSILON = 1e-9

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

function sortedTransactions(transactions: NormalizedTransaction[]): NormalizedTransaction[] {
  return [...transactions].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber,
  )
}

function emptyWallet(currency: string): MutableWallet {
  return {
    currency,
    deposits: 0,
    withdrawals: 0,
    explicitFxIn: 0,
    explicitFxOut: 0,
    autoFundedIn: 0,
    autoFundingOut: 0,
    securitySpent: 0,
    securityReceived: 0,
    fees: 0,
    endingBalance: 0,
  }
}

export function buildCashFundingLedger(transactions: NormalizedTransaction[]): CashLedgerResult {
  const trackingMode: CashTrackingMode = transactions.some((row) => row.transactionType !== 'SECURITY')
    ? 'TRACKED'
    : 'UNTRACKED'

  if (trackingMode === 'UNTRACKED') {
    return { trackingMode, wallets: [], issues: [], blockingIssueCount: 0 }
  }

  const wallets = new Map<string, MutableWallet>()
  const issues: CashLedgerIssue[] = []

  const walletFor = (currency: string): MutableWallet => {
    const normalized = currency.toUpperCase()
    const existing = wallets.get(normalized)
    if (existing) return existing
    const created = emptyWallet(normalized)
    wallets.set(normalized, created)
    return created
  }

  const block = (
    row: NormalizedTransaction,
    code: CashLedgerIssueCode,
    message: string,
    required?: number,
    available?: number,
  ) => {
    issues.push({
      code,
      severity: 'BLOCKING',
      sourceRowNumber: row.sourceRowNumber,
      tradeDate: row.tradeDate,
      currency: row.currency,
      message,
      required,
      available,
    })
  }

  for (const row of sortedTransactions(transactions)) {
    const wallet = walletFor(row.currency)

    if (row.transactionType === 'CASH_IN') {
      const net = row.amountForeign - row.fee
      if (net < -EPSILON) {
        block(row, 'NEGATIVE_NET_CASH_IN', `第 ${row.sourceRowNumber} 列入金扣除費用後為負數`)
        continue
      }
      wallet.deposits += row.amountForeign
      wallet.fees += row.fee
      wallet.endingBalance = clean(wallet.endingBalance + net)
      continue
    }

    if (row.transactionType === 'CASH_OUT') {
      const required = row.amountForeign + row.fee
      if (wallet.endingBalance + EPSILON < required) {
        block(
          row,
          'CASH_OUT_EXCEEDS_BALANCE',
          `第 ${row.sourceRowNumber} 列出金超過 ${row.currency} 可用餘額`,
          required,
          wallet.endingBalance,
        )
        continue
      }
      wallet.withdrawals += row.amountForeign
      wallet.fees += row.fee
      wallet.endingBalance = clean(wallet.endingBalance - required)
      continue
    }

    if (row.transactionType === 'FX_BUY') {
      if (row.currency === 'TWD') {
        block(row, 'INVALID_FX_CURRENCY', 'FX_BUY 的幣別必須是欲買入的外幣，不可填 TWD')
        continue
      }
      if (row.fxRate === null || row.fxRate <= 0) {
        block(row, 'MISSING_FX_RATE', `第 ${row.sourceRowNumber} 列 FX_BUY 缺少實際換匯匯率`)
        continue
      }
      const twd = walletFor('TWD')
      const twdCountervalue = row.amountForeign * row.fxRate
      const requiredTwd = twdCountervalue + row.fee
      if (twd.endingBalance + EPSILON < requiredTwd) {
        block(
          row,
          'INSUFFICIENT_TWD_FOR_FX_BUY',
          `第 ${row.sourceRowNumber} 列買入 ${row.currency} 的台幣資金不足`,
          requiredTwd,
          twd.endingBalance,
        )
        continue
      }
      twd.explicitFxOut += twdCountervalue
      twd.fees += row.fee
      twd.endingBalance = clean(twd.endingBalance - requiredTwd)
      wallet.explicitFxIn += row.amountForeign
      wallet.endingBalance = clean(wallet.endingBalance + row.amountForeign)
      continue
    }

    if (row.transactionType === 'FX_SELL') {
      if (row.currency === 'TWD') {
        block(row, 'INVALID_FX_CURRENCY', 'FX_SELL 的幣別必須是欲賣出的外幣，不可填 TWD')
        continue
      }
      if (row.fxRate === null || row.fxRate <= 0) {
        block(row, 'MISSING_FX_RATE', `第 ${row.sourceRowNumber} 列 FX_SELL 缺少實際換匯匯率`)
        continue
      }
      if (wallet.endingBalance + EPSILON < row.amountForeign) {
        block(
          row,
          'FX_SELL_EXCEEDS_BALANCE',
          `第 ${row.sourceRowNumber} 列賣出外幣超過 ${row.currency} 可用餘額`,
          row.amountForeign,
          wallet.endingBalance,
        )
        continue
      }
      const grossTwd = row.amountForeign * row.fxRate
      const netTwd = grossTwd - row.fee
      if (netTwd < -EPSILON) {
        block(row, 'NEGATIVE_NET_FX_PROCEEDS', `第 ${row.sourceRowNumber} 列換匯費用高於台幣賣出收入`)
        continue
      }
      const twd = walletFor('TWD')
      wallet.explicitFxOut += row.amountForeign
      wallet.endingBalance = clean(wallet.endingBalance - row.amountForeign)
      twd.explicitFxIn += grossTwd
      twd.fees += row.fee
      twd.endingBalance = clean(twd.endingBalance + netTwd)
      continue
    }

    if (row.transactionType === 'SECURITY') {
      if (row.quantity > 0) {
        const required = row.amountForeign + row.fee

        if (row.currency !== 'TWD' && wallet.endingBalance + EPSILON < required) {
          const shortfall = required - wallet.endingBalance
          if (row.fxRate === null || row.fxRate <= 0) {
            block(
              row,
              'MISSING_FX_RATE_FOR_AUTO_FUND',
              `第 ${row.sourceRowNumber} 列外幣證券買入資金不足，且缺少自動換匯匯率`,
              shortfall,
              wallet.endingBalance,
            )
            continue
          }
          const twd = walletFor('TWD')
          const requiredTwd = shortfall * row.fxRate
          if (twd.endingBalance + EPSILON < requiredTwd) {
            block(
              row,
              'INSUFFICIENT_TWD_FOR_AUTO_FUND',
              `第 ${row.sourceRowNumber} 列外幣證券自動換匯所需台幣不足`,
              requiredTwd,
              twd.endingBalance,
            )
            continue
          }
          twd.autoFundingOut += requiredTwd
          twd.endingBalance = clean(twd.endingBalance - requiredTwd)
          wallet.autoFundedIn += shortfall
          wallet.endingBalance = clean(wallet.endingBalance + shortfall)
        }

        if (wallet.endingBalance + EPSILON < required) {
          block(
            row,
            'INSUFFICIENT_CASH_FOR_SECURITY_BUY',
            `第 ${row.sourceRowNumber} 列證券買入超過 ${row.currency} 可用現金`,
            required,
            wallet.endingBalance,
          )
          continue
        }

        wallet.securitySpent += row.amountForeign
        wallet.fees += row.fee
        wallet.endingBalance = clean(wallet.endingBalance - required)
        continue
      }

      const netProceeds = row.amountForeign - row.fee
      if (netProceeds < -EPSILON) {
        block(row, 'NEGATIVE_NET_SECURITY_PROCEEDS', `第 ${row.sourceRowNumber} 列證券賣出費用高於賣出收入`)
        continue
      }
      wallet.securityReceived += row.amountForeign
      wallet.fees += row.fee
      wallet.endingBalance = clean(wallet.endingBalance + netProceeds)
    }
  }

  return {
    trackingMode,
    wallets: [...wallets.values()]
      .map((wallet) => ({
        ...wallet,
        deposits: clean(wallet.deposits),
        withdrawals: clean(wallet.withdrawals),
        explicitFxIn: clean(wallet.explicitFxIn),
        explicitFxOut: clean(wallet.explicitFxOut),
        autoFundedIn: clean(wallet.autoFundedIn),
        autoFundingOut: clean(wallet.autoFundingOut),
        securitySpent: clean(wallet.securitySpent),
        securityReceived: clean(wallet.securityReceived),
        fees: clean(wallet.fees),
        endingBalance: clean(wallet.endingBalance),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    issues,
    blockingIssueCount: issues.length,
  }
}
