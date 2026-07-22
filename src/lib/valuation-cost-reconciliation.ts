import type { FxCostPoolResult, SecurityTwdBasis } from './fx-cost-pool'
import type { PointInTimeValuation, PositionValuation } from './valuation'

const EPSILON = 1e-9

export type PositionTwdReconciliation = {
  ticker: string
  currency: string
  marketValueTwd: number | null
  twdCostBasis: number | null
  unrealizedPnlTwd: number | null
}

export type ValuationCostReconciliation = {
  complete: boolean
  positions: PositionTwdReconciliation[]
  totalPositionMarketValueTwd: number | null
  totalPositionTwdCostBasis: number | null
  totalUnrealizedPnlTwd: number | null
  totalRealizedPnlTwd: number | null
  missingCostKeys: string[]
  costBlockingIssueCount: number
}

function key(ticker: string, currency: string): string {
  return `${ticker.toUpperCase()}\u0000${currency.toUpperCase()}`
}

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

function openCostPositions(cost: FxCostPoolResult): Map<string, SecurityTwdBasis> {
  return new Map(
    cost.positions
      .filter((position) => position.quantity > EPSILON)
      .map((position) => [key(position.ticker, position.currency), position]),
  )
}

function reconcilePosition(
  position: PositionValuation,
  costPositions: Map<string, SecurityTwdBasis>,
): PositionTwdReconciliation {
  const cost = costPositions.get(key(position.ticker, position.currency))
  const twdCostBasis = cost?.twdCostBasis ?? null
  const unrealizedPnlTwd = position.marketValueTwd !== null && twdCostBasis !== null
    ? clean(position.marketValueTwd - twdCostBasis)
    : null

  return {
    ticker: position.ticker,
    currency: position.currency,
    marketValueTwd: position.marketValueTwd,
    twdCostBasis,
    unrealizedPnlTwd,
  }
}

export function reconcileValuationWithTwdCost(
  valuation: PointInTimeValuation,
  cost: FxCostPoolResult,
): ValuationCostReconciliation {
  const costPositions = openCostPositions(cost)
  const positions = valuation.positions.map((position) => reconcilePosition(position, costPositions))
  const missingCostKeys = positions
    .filter((position) => position.twdCostBasis === null)
    .map((position) => `${position.ticker}:${position.currency}`)

  const complete = valuation.complete
    && cost.blockingIssueCount === 0
    && missingCostKeys.length === 0
    && positions.every((position) => position.marketValueTwd !== null && position.unrealizedPnlTwd !== null)

  const totalPositionMarketValueTwd = complete
    ? clean(positions.reduce((total, position) => total + (position.marketValueTwd ?? 0), 0))
    : null
  const totalPositionTwdCostBasis = complete
    ? clean(positions.reduce((total, position) => total + (position.twdCostBasis ?? 0), 0))
    : null
  const totalUnrealizedPnlTwd = complete
    ? clean(positions.reduce((total, position) => total + (position.unrealizedPnlTwd ?? 0), 0))
    : null
  const totalRealizedPnlTwd = cost.blockingIssueCount === 0
    ? clean(
      cost.positions.reduce((total, position) => total + position.realizedPnlTwd, 0)
      + cost.pools.reduce((total, pool) => total + pool.realizedFxPnlTwd, 0),
    )
    : null

  return {
    complete,
    positions,
    totalPositionMarketValueTwd,
    totalPositionTwdCostBasis,
    totalUnrealizedPnlTwd,
    totalRealizedPnlTwd,
    missingCostKeys,
    costBlockingIssueCount: cost.blockingIssueCount,
  }
}
