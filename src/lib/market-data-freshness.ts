export const MARKET_DATA_STALE_AFTER_DAYS = 4

export type DateFreshnessReason = 'CURRENT' | 'MISSING_DATE' | 'FUTURE_DATE' | 'AGE_LIMIT_EXCEEDED'

export type DateFreshness = {
  stale: boolean
  ageDays: number | null
  staleAfterDays: number
  reason: DateFreshnessReason
}

function utcDateStart(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) ? parsed : null
}

export function determineDateFreshness(
  asOf: string | null | undefined,
  now = new Date(),
  staleAfterDays = MARKET_DATA_STALE_AFTER_DAYS,
): DateFreshness {
  const asOfTime = asOf ? utcDateStart(asOf) : null
  if (asOfTime === null) {
    return { stale: true, ageDays: null, staleAfterDays, reason: 'MISSING_DATE' }
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const ageDays = Math.floor((today - asOfTime) / 86_400_000)
  if (ageDays < 0) return { stale: true, ageDays, staleAfterDays, reason: 'FUTURE_DATE' }
  return {
    stale: ageDays > staleAfterDays,
    ageDays,
    staleAfterDays,
    reason: ageDays > staleAfterDays ? 'AGE_LIMIT_EXCEEDED' : 'CURRENT',
  }
}

export function staleMarketDataMessage(asOf: string | null | undefined, ageDays: number | null): string {
  if (!asOf || ageDays === null) return '行情日期無效，無法確認資料是否為最新'
  if (ageDays < 0) return `行情日期 ${asOf} 晚於目前日期，請檢查資料來源`
  return `行情截至 ${asOf}，已過期 ${ageDays} 天`
}
