import type { NormalizedTransaction } from './contracts'

const EPSILON = 1e-9

export type FxCostMethod = 'MOVING_AVERAGE'

export type FxCostIssueCode =
  | 'INVALID_FX_CURRENCY'
  | 'MISSING_FX_RATE'
  | 'MISSING_FX_RATE_FOR_AUTO_FUND'
  | 'MISSING_SECURITY_SALE_FX'
  | 'NEGATIVE_NET_CASH_IN'
  | 'NEGATIVE_NET_FX_PROCEEDS'
  | 'NEGATIVE_NET_SECURITY_PROCEEDS'
  | 'INSUFFICIENT_FOREIGN_POOL'
  | 'OVERSELL'

export type FxCostIssue = {
  code: FxCostIssueCode
  severity: 'BLOCKING'
  sourceRowNumber: number
  tradeDate: string
  ticker: string
  currency: string
  message: string
  required?: number
  available?: number
}

export type ForeignCurrencyCostPool = {
  currency: string
  units: number
  twdCostBasis: number
  averageFxCost: number
  explicitFxUnitsIn: number
  externalCashUnitsIn: number
  automaticUnitsIn: number
  unitsAssignedToSecurities: number
  unitsSoldToTwd: number
  unitsWithdrawn: number
  foreignFeeUnits: number
  foreignFeeTwdCost: number
  twdFees: number
  realizedFxPnlTwd: number
}

export type SecurityTwdBasis = {
  ticker: string
  currency: string
  quantity: number
  nativeCostBasis: number
  twdCostBasis: number
  averageNativeUnitCost: number
  averageTwdUnitCost: number
  realizedPnlTwd: number
  tradeCount: number
}

export type FxCostPoolResult = {
  method: FxCostMethod
  pools: ForeignCurrencyCostPool[]
  positions: SecurityTwdBasis[]
  issues: FxCostIssue[]
  blockingIssueCount: number
}

type MutablePool = Omit<ForeignCurrencyCostPool, 'averageFxCost'>
type MutablePosition = Omit<SecurityTwdBasis, 'averageNativeUnitCost' | 'averageTwdUnitCost'>

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

function sortedTransactions(transactions: NormalizedTransaction[]): NormalizedTransaction[] {
  return [...transactions].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber,
  )
}

function poolKey(currency: string): string {
  return currency.toUpperCase()
}

function positionKey(ticker: string, currency: string): string {
  return `${ticker.toUpperCase()}\u0000${currency.toUpperCase()}`
}

function emptyPool(currency: string): MutablePool {
  return {
    currency,
    units: 0,
    twdCostBasis: 0,
    explicitFxUnitsIn: 0,
    externalCashUnitsIn: 0,
    automaticUnitsIn: 0,
    unitsAssignedToSecurities: 0,
    unitsSoldToTwd: 0,
    unitsWithdrawn: 0,
    foreignFeeUnits: 0,
    foreignFeeTwdCost: 0,
    twdFees: 0,
    realizedFxPnlTwd: 0,
  }
}

function emptyPosition(ticker: string, currency: string): MutablePosition {
  return {
    ticker,
    currency,
    quantity: 0,
    nativeCostBasis: 0,
    twdCostBasis: 0,
    realizedPnlTwd: 0,
    tradeCount: 0,
  }
}

function addToPool(pool: MutablePool, units: number, twdCostBasis: number): void {
  pool.units = clean(pool.units + units)
  pool.twdCostBasis = clean(pool.twdCostBasis + twdCostBasis)
}

function consumeFromPool(pool: MutablePool, units: number): number | null {
  if (pool.units + EPSILON < units) return null
  const averageFxCost = pool.units > EPSILON ? pool.twdCostBasis / pool.units : 0
  const releasedTwdCost = averageFxCost * units
  pool.units = clean(pool.units - units)
  pool.twdCostBasis = clean(pool.twdCostBasis - releasedTwdCost)
  if (pool.units === 0) pool.twdCostBasis = 0
  return releasedTwdCost
}

export function buildFxCostPool(transactions: NormalizedTransaction[]): FxCostPoolResult {
  const pools = new Map<string, MutablePool>()
  const positions = new Map<string, MutablePosition>()
  const issues: FxCostIssue[] = []

  const poolFor = (currency: string): MutablePool => {
    const normalized = poolKey(currency)
    const existing = pools.get(normalized)
    if (existing) return existing
    const created = emptyPool(normalized)
    pools.set(normalized, created)
    return created
  }

  const positionFor = (ticker: string, currency: string): MutablePosition => {
    const normalizedTicker = ticker.toUpperCase()
    const normalizedCurrency = currency.toUpperCase()
    const key = positionKey(normalizedTicker, normalizedCurrency)
    const existing = positions.get(key)
    if (existing) return existing
    const created = emptyPosition(normalizedTicker, normalizedCurrency)
    positions.set(key, created)
    return created
  }

  const block = (
    row: NormalizedTransaction,
    code: FxCostIssueCode,
    message: string,
    required?: number,
    available?: number,
  ) => {
    issues.push({
      code,
      severity: 'BLOCKING',
      sourceRowNumber: row.sourceRowNumber,
      tradeDate: row.tradeDate,
      ticker: row.ticker,
      currency: row.currency,
      message,
      required,
      available,
    })
  }

  for (const row of sortedTransactions(transactions)) {
    const currency = row.currency.toUpperCase()
    const amount = row.amountForeign > 0 ? row.amountForeign : Math.abs(row.quantity) * row.price

    if (row.transactionType === 'FX_BUY') {
      if (currency === 'TWD') {
        block(row, 'INVALID_FX_CURRENCY', 'FX_BUY 的幣別必須是欲買入的外幣，不可填 TWD')
        continue
      }
      if (row.fxRate === null || row.fxRate <= 0) {
        block(row, 'MISSING_FX_RATE', `第 ${row.sourceRowNumber} 列 FX_BUY 缺少實際換匯匯率`)
        continue
      }
      const pool = poolFor(currency)
      addToPool(pool, amount, amount * row.fxRate + row.fee)
      pool.explicitFxUnitsIn += amount
      pool.twdFees += row.fee
      continue
    }

    if (row.transactionType === 'FX_SELL') {
      if (currency === 'TWD') {
        block(row, 'INVALID_FX_CURRENCY', 'FX_SELL 的幣別必須是欲賣出的外幣，不可填 TWD')
        continue
      }
      if (row.fxRate === null || row.fxRate <= 0) {
        block(row, 'MISSING_FX_RATE', `第 ${row.sourceRowNumber} 列 FX_SELL 缺少實際換匯匯率`)
        continue
      }
      const grossTwd = amount * row.fxRate
      const netTwd = grossTwd - row.fee
      if (netTwd < -EPSILON) {
        block(row, 'NEGATIVE_NET_FX_PROCEEDS', `第 ${row.sourceRowNumber} 列換匯費用高於台幣賣出收入`)
        continue
      }
      const pool = poolFor(currency)
      const releasedTwdCost = consumeFromPool(pool, amount)
      if (releasedTwdCost === null) {
        block(
          row,
          'INSUFFICIENT_FOREIGN_POOL',
          `第 ${row.sourceRowNumber} 列賣出 ${currency} 超過外幣成本池餘額`,
          amount,
          pool.units,
        )
        continue
      }
      pool.unitsSoldToTwd += amount
      pool.twdFees += row.fee
      pool.realizedFxPnlTwd += netTwd - releasedTwdCost
      continue
    }

    if (row.transactionType === 'CASH_IN') {
      if (currency === 'TWD') continue
      if (row.fxRate === null || row.fxRate <= 0) {
        block(row, 'MISSING_FX_RATE', `第 ${row.sourceRowNumber} 列外幣入金缺少實際成本匯率`)
        continue
      }
      const netUnits = amount - row.fee
      if (netUnits < -EPSILON) {
        block(row, 'NEGATIVE_NET_CASH_IN', `第 ${row.sourceRowNumber} 列外幣入金扣除費用後為負數`)
        continue
      }
      const pool = poolFor(currency)
      addToPool(pool, netUnits, netUnits * row.fxRate)
      pool.externalCashUnitsIn += netUnits
      pool.foreignFeeUnits += row.fee
      pool.foreignFeeTwdCost += row.fee * row.fxRate
      continue
    }

    if (row.transactionType === 'CASH_OUT') {
      if (currency === 'TWD') continue
      const pool = poolFor(currency)
      const requiredUnits = amount + row.fee
      const averageBefore = pool.units > EPSILON ? pool.twdCostBasis / pool.units : 0
      const releasedTwdCost = consumeFromPool(pool, requiredUnits)
      if (releasedTwdCost === null) {
        block(
          row,
          'INSUFFICIENT_FOREIGN_POOL',
          `第 ${row.sourceRowNumber} 列外幣出金超過 ${currency} 成本池餘額`,
          requiredUnits,
          pool.units,
        )
        continue
      }
      pool.unitsWithdrawn += amount
      pool.foreignFeeUnits += row.fee
      pool.foreignFeeTwdCost += row.fee * averageBefore
      continue
    }

    if (row.transactionType !== 'SECURITY') continue

    const position = positionFor(row.ticker, currency)

    if (row.quantity > 0) {
      const nativeCost = amount + row.fee
      let twdCost = nativeCost

      if (currency !== 'TWD') {
        const pool = poolFor(currency)
        if (pool.units + EPSILON < nativeCost) {
          const shortfall = nativeCost - pool.units
          if (row.fxRate === null || row.fxRate <= 0) {
            block(
              row,
              'MISSING_FX_RATE_FOR_AUTO_FUND',
              `第 ${row.sourceRowNumber} 列外幣證券買入資金不足，且缺少自動換匯匯率`,
              shortfall,
              pool.units,
            )
            continue
          }
          addToPool(pool, shortfall, shortfall * row.fxRate)
          pool.automaticUnitsIn += shortfall
        }

        const releasedTwdCost = consumeFromPool(pool, nativeCost)
        if (releasedTwdCost === null) {
          block(
            row,
            'INSUFFICIENT_FOREIGN_POOL',
            `第 ${row.sourceRowNumber} 列外幣證券買入超過 ${currency} 成本池餘額`,
            nativeCost,
            pool.units,
          )
          continue
        }
        pool.unitsAssignedToSecurities += nativeCost
        twdCost = releasedTwdCost
      }

      position.quantity += row.quantity
      position.nativeCostBasis += nativeCost
      position.twdCostBasis += twdCost
      position.tradeCount += 1
      continue
    }

    const sellQuantity = Math.abs(row.quantity)
    if (sellQuantity > position.quantity + EPSILON) {
      block(
        row,
        'OVERSELL',
        `${row.ticker} 欲賣出 ${sellQuantity} 股，但 TWD 成本帳當時僅持有 ${position.quantity} 股`,
        sellQuantity,
        position.quantity,
      )
      continue
    }

    const netProceedsNative = amount - row.fee
    if (netProceedsNative < -EPSILON) {
      block(row, 'NEGATIVE_NET_SECURITY_PROCEEDS', `第 ${row.sourceRowNumber} 列證券賣出費用高於賣出收入`)
      continue
    }
    if (currency !== 'TWD' && netProceedsNative > EPSILON && (row.fxRate === null || row.fxRate <= 0)) {
      block(row, 'MISSING_SECURITY_SALE_FX', `第 ${row.sourceRowNumber} 列外幣證券賣出缺少成交日匯率`)
      continue
    }

    const averageNativeUnitCost = position.quantity > EPSILON
      ? position.nativeCostBasis / position.quantity
      : 0
    const averageTwdUnitCost = position.quantity > EPSILON
      ? position.twdCostBasis / position.quantity
      : 0
    const releasedNativeCost = averageNativeUnitCost * sellQuantity
    const releasedTwdCost = averageTwdUnitCost * sellQuantity
    const proceedsTwd = currency === 'TWD'
      ? netProceedsNative
      : netProceedsNative * (row.fxRate ?? 0)

    position.quantity = clean(position.quantity - sellQuantity)
    position.nativeCostBasis = clean(position.nativeCostBasis - releasedNativeCost)
    position.twdCostBasis = clean(position.twdCostBasis - releasedTwdCost)
    position.realizedPnlTwd += proceedsTwd - releasedTwdCost
    position.tradeCount += 1
    if (position.quantity === 0) {
      position.nativeCostBasis = 0
      position.twdCostBasis = 0
    }

    if (currency !== 'TWD' && netProceedsNative > EPSILON) {
      const pool = poolFor(currency)
      addToPool(pool, netProceedsNative, proceedsTwd)
    }
  }

  return {
    method: 'MOVING_AVERAGE',
    pools: [...pools.values()]
      .map((pool): ForeignCurrencyCostPool => ({
        ...pool,
        units: clean(pool.units),
        twdCostBasis: clean(pool.twdCostBasis),
        averageFxCost: pool.units > EPSILON ? pool.twdCostBasis / pool.units : 0,
        realizedFxPnlTwd: clean(pool.realizedFxPnlTwd),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    positions: [...positions.values()]
      .map((position): SecurityTwdBasis => ({
        ...position,
        quantity: clean(position.quantity),
        nativeCostBasis: clean(position.nativeCostBasis),
        twdCostBasis: clean(position.twdCostBasis),
        averageNativeUnitCost: position.quantity > EPSILON
          ? position.nativeCostBasis / position.quantity
          : 0,
        averageTwdUnitCost: position.quantity > EPSILON
          ? position.twdCostBasis / position.quantity
          : 0,
        realizedPnlTwd: clean(position.realizedPnlTwd),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency) || a.ticker.localeCompare(b.ticker)),
    issues,
    blockingIssueCount: issues.length,
  }
}
