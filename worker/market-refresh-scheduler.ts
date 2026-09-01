import type { MarketDataRefreshResponse } from '../src/lib/market-data-contracts'
import { getMarketState } from './market-data-repository'
import { refreshMarketData } from './market-data-service'
import { getPortfolioState } from './repository'
import { currentValuationRevision } from './valuation-repository'

const MAX_SCHEDULED_USERS = 10
const MAX_ATTEMPTS = 2

type User = { id: string; email: string }
type Refresh = typeof refreshMarketData

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('VERSION_CONFLICT')) return message.split(':')[0]
  const http = message.match(/HTTP\s+(\d{3})/)
  if (http) return `UPSTREAM_HTTP_${http[1]}`
  if (/fetch|network|timeout/i.test(message)) return 'UPSTREAM_NETWORK_ERROR'
  if (message.startsWith('VALUATION_INCOMPLETE:')) return 'VALUATION_INCOMPLETE'
  return 'MARKET_REFRESH_FAILED'
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP\s+(429|5\d\d)|fetch|network|timeout/i.test(message)
}

async function reserveJob(
  db: D1Database,
  userId: string,
  scheduledFor: string,
  marketRevision: number,
  valuationRevision: number,
): Promise<{ id: string; reserved: boolean }> {
  const id = `scheduled:${userId}:${scheduledFor}`
  const result = await db.prepare(
    `INSERT OR IGNORE INTO market_refresh_jobs
       (id, user_id, trigger_type, scheduled_for, status, attempt_count,
        market_revision_before, valuation_revision_before)
     VALUES (?, ?, 'SCHEDULED', ?, 'RUNNING', 0, ?, ?)`,
  ).bind(id, userId, scheduledFor, marketRevision, valuationRevision).run()
  return { id, reserved: Number(result.meta.changes ?? 0) === 1 }
}

async function finishJob(
  db: D1Database,
  id: string,
  input: {
    status: 'SUCCEEDED' | 'SKIPPED' | 'FAILED'
    attempts: number
    marketRevisionAfter: number | null
    valuationRevisionAfter: number | null
    latestBarDate: string | null
    reasonCode: string | null
    reasonMessage: string | null
  },
): Promise<void> {
  await db.prepare(
    `UPDATE market_refresh_jobs
        SET status = ?, attempt_count = ?, market_revision_after = ?,
            valuation_revision_after = ?, latest_bar_date = ?, reason_code = ?,
            reason_message = ?, finished_at = datetime('now')
      WHERE id = ? AND status = 'RUNNING'`,
  ).bind(
    input.status,
    input.attempts,
    input.marketRevisionAfter,
    input.valuationRevisionAfter,
    input.latestBarDate,
    input.reasonCode,
    input.reasonMessage,
    id,
  ).run()
}

async function refreshOne(
  db: D1Database,
  user: User,
  scheduledFor: string,
  now: Date,
  refresh: Refresh,
): Promise<void> {
  const [portfolio, market, valuationRevision] = await Promise.all([
    getPortfolioState(db, user.id),
    getMarketState(db, user.id),
    currentValuationRevision(db, user.id),
  ])
  const reservation = await reserveJob(
    db,
    user.id,
    scheduledFor,
    market.market_revision,
    valuationRevision,
  )
  if (!reservation.reserved) return
  if (!portfolio.activeDatasetId || portfolio.cloudRevision === 0) {
    await finishJob(db, reservation.id, {
      status: 'SKIPPED',
      attempts: 0,
      marketRevisionAfter: market.market_revision,
      valuationRevisionAfter: valuationRevision,
      latestBarDate: null,
      reasonCode: 'NO_ACTIVE_DATASET',
      reasonMessage: '目前沒有 ACTIVE 交易資料，排程未更新行情',
    })
    return
  }

  let attempts = 0
  let lastError: unknown
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1
    try {
      const result: MarketDataRefreshResponse = await refresh(db, user, {
        baseValuationRevision: valuationRevision,
        transactionDatasetId: portfolio.activeDatasetId,
        transactionRevision: portfolio.cloudRevision,
      }, { now })
      await finishJob(db, reservation.id, {
        status: 'SUCCEEDED',
        attempts,
        marketRevisionAfter: result.market.marketRevision,
        valuationRevisionAfter: result.valuation.valuationRevision,
        latestBarDate: result.market.activeRun?.latestBarDate ?? null,
        reasonCode: null,
        reasonMessage: null,
      })
      return
    } catch (error) {
      lastError = error
      if (!isRetryable(error) || attempts >= MAX_ATTEMPTS) break
    }
  }

  const code = errorCode(lastError)
  const skipped = code.endsWith('VERSION_CONFLICT')
  await finishJob(db, reservation.id, {
    status: skipped ? 'SKIPPED' : 'FAILED',
    attempts,
    marketRevisionAfter: null,
    valuationRevisionAfter: null,
    latestBarDate: null,
    reasonCode: code,
    reasonMessage: lastError instanceof Error ? lastError.message : String(lastError),
  })
}

export async function runScheduledMarketRefresh(
  db: D1Database,
  scheduledTime: number,
  options: { now?: Date; refresh?: Refresh } = {},
): Promise<void> {
  const now = options.now ?? new Date(scheduledTime)
  const scheduledFor = new Date(scheduledTime).toISOString()
  const users = await db.prepare(
    `SELECT users.id, users.email
       FROM users
      ORDER BY users.id
      LIMIT ?`,
  ).bind(MAX_SCHEDULED_USERS).all<User>()
  for (const user of users.results) {
    await refreshOne(db, user, scheduledFor, now, options.refresh ?? refreshMarketData)
  }
}
