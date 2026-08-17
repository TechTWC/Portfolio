import type { NormalizedTransaction } from './contracts'
import {
  buildHistoricalNavSeries,
  type HistoricalNavInput,
  type HistoricalNavSeries,
} from './historical-nav'

const DAY_MS = 86_400_000
const EPSILON = 1e-9
export const HISTORICAL_PERFORMANCE_CALCULATION_VERSION = 'historical-performance-v0.6'

export type HistoricalPerformanceIssueCode =
  | 'INSUFFICIENT_OBSERVATIONS'
  | 'INCOMPLETE_NAV_POINT'
  | 'NON_POSITIVE_TWR_DENOMINATOR'
  | 'INVALID_GROWTH_FACTOR'
  | 'ZERO_TIME_SPAN'
  | 'UNSUPPORTED_TOTAL_RETURN_COVERAGE'

export type HistoricalPerformanceIssue = {
  code: HistoricalPerformanceIssueCode
  message: string
  dates: string[]
}

export type TwrObservation = {
  date: string
  complete: boolean
  totalAssetsTwd: number | null
  contributionTwd: number
  withdrawalTwd: number
}

export type TwrPoint = TwrObservation & {
  periodReturn: number | null
  growthIndex: number | null
  cumulativeTwr: number | null
  runningPeakIndex: number | null
  drawdown: number | null
}

export type DrawdownSummary = {
  maximumDrawdown: number | null
  peakDate: string | null
  troughDate: string | null
  declineDays: number | null
  recoveryDate: string | null
  recoveryDays: number | null
  underwaterDays: number | null
  currentDrawdown: number | null
  currentlyInDrawdown: boolean | null
  currentPeakDate: string | null
  currentUnderwaterDays: number | null
}

export type TimeWeightedPerformance = {
  complete: boolean
  startDate: string | null
  endDate: string | null
  dayCount: number | null
  cumulativeTwr: number | null
  annualizedTwr: number | null
  points: TwrPoint[]
  drawdown: DrawdownSummary
  issues: HistoricalPerformanceIssue[]
  blockingIssueCount: number
}

export type HistoricalPerformanceSeries = {
  requestedDates: string[]
  observationDates: string[]
  navSeries: HistoricalNavSeries
  performance: TimeWeightedPerformance
  provenance: HistoricalPerformanceProvenance
}

export type HistoricalPerformanceSource = {
  transactionRevision: number
  valuationRevision: number
  valuationSnapshotId: string | null
  valuationDate: string | null
}

export type HistoricalPerformanceProvenance = HistoricalPerformanceSource & {
  calculationVersion: typeof HISTORICAL_PERFORMANCE_CALCULATION_VERSION
}

export type HistoricalPerformanceInput = HistoricalNavInput & HistoricalPerformanceSource & {
  totalReturnCoverage: 'COMPLETE' | 'PRICE_ONLY'
}

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

function utcTime(value: string): number {
  return Date.parse(`${value}T00:00:00Z`)
}

function daysBetween(start: string, end: string): number {
  return Math.round((utcTime(end) - utcTime(start)) / DAY_MS)
}

function emptyDrawdown(): DrawdownSummary {
  return {
    maximumDrawdown: null,
    peakDate: null,
    troughDate: null,
    declineDays: null,
    recoveryDate: null,
    recoveryDays: null,
    underwaterDays: null,
    currentDrawdown: null,
    currentlyInDrawdown: null,
    currentPeakDate: null,
    currentUnderwaterDays: null,
  }
}

function normalizeObservations(observations: TwrObservation[]): TwrObservation[] {
  const byDate = new Map<string, TwrObservation>()
  for (const observation of observations) {
    byDate.set(observation.date, observation)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function calculateTimeWeightedPerformance(
  rawObservations: TwrObservation[],
): TimeWeightedPerformance {
  const observations = normalizeObservations(rawObservations)
  const issues: HistoricalPerformanceIssue[] = []

  if (observations.length < 2) {
    issues.push({
      code: 'INSUFFICIENT_OBSERVATIONS',
      message: '至少需要兩個完整 NAV 觀察點才能計算 TWR 與回撤',
      dates: observations.map((item) => item.date),
    })
  }

  const incompleteDates = observations
    .filter((item) => !item.complete || item.totalAssetsTwd === null)
    .map((item) => item.date)
  if (incompleteDates.length > 0) {
    issues.push({
      code: 'INCOMPLETE_NAV_POINT',
      message: `有 ${incompleteDates.length} 個 NAV 點不完整，不能把已知部分資產串成績效`,
      dates: incompleteDates,
    })
  }

  const startDate = observations[0]?.date ?? null
  const endDate = observations.at(-1)?.date ?? null
  const dayCount = startDate && endDate ? daysBetween(startDate, endDate) : null
  if (dayCount !== null && dayCount <= 0 && observations.length >= 2) {
    issues.push({
      code: 'ZERO_TIME_SPAN',
      message: '歷史 NAV 起訖日沒有正的時間跨度，無法年化',
      dates: startDate ? [startDate] : [],
    })
  }

  const points: TwrPoint[] = observations.map((observation) => ({
    ...observation,
    periodReturn: null,
    growthIndex: null,
    cumulativeTwr: null,
    runningPeakIndex: null,
    drawdown: null,
  }))

  if (issues.length > 0) {
    return {
      complete: false,
      startDate,
      endDate,
      dayCount,
      cumulativeTwr: null,
      annualizedTwr: null,
      points,
      drawdown: emptyDrawdown(),
      issues,
      blockingIssueCount: issues.length,
    }
  }

  let growthIndex = 1
  points[0].growthIndex = 1
  points[0].cumulativeTwr = 0
  points[0].runningPeakIndex = 1
  points[0].drawdown = 0

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const denominator = (previous.totalAssetsTwd ?? 0) + current.contributionTwd
    const numerator = (current.totalAssetsTwd ?? 0) + current.withdrawalTwd

    if (!Number.isFinite(denominator) || denominator <= EPSILON) {
      issues.push({
        code: 'NON_POSITIVE_TWR_DENOMINATOR',
        message: `${current.date} 的期初 NAV 加當日投入不是正數，無法計算區間報酬`,
        dates: [previous.date, current.date],
      })
      continue
    }

    const periodReturn = numerator / denominator - 1
    const periodFactor = 1 + periodReturn
    if (!Number.isFinite(periodFactor) || periodFactor < -EPSILON) {
      issues.push({
        code: 'INVALID_GROWTH_FACTOR',
        message: `${current.date} 的區間成長因子無效`,
        dates: [previous.date, current.date],
      })
      continue
    }

    growthIndex = clean(growthIndex * Math.max(0, periodFactor))
    current.periodReturn = clean(periodReturn)
    current.growthIndex = growthIndex
    current.cumulativeTwr = clean(growthIndex - 1)
  }

  if (issues.length > 0 || points.some((point) => point.growthIndex === null)) {
    return {
      complete: false,
      startDate,
      endDate,
      dayCount,
      cumulativeTwr: null,
      annualizedTwr: null,
      points,
      drawdown: emptyDrawdown(),
      issues,
      blockingIssueCount: issues.length,
    }
  }

  let runningPeak = points[0].growthIndex ?? 1
  let runningPeakDate = points[0].date
  let maximumDrawdown = 0
  let maximumPeakDate = points[0].date
  let maximumTroughDate = points[0].date
  let maximumPeakIndex = runningPeak

  for (const point of points) {
    const indexValue = point.growthIndex ?? 0
    if (indexValue > runningPeak + EPSILON) {
      runningPeak = indexValue
      runningPeakDate = point.date
    }
    const drawdown = runningPeak > EPSILON ? indexValue / runningPeak - 1 : 0
    point.runningPeakIndex = runningPeak
    point.drawdown = clean(drawdown)

    if (drawdown < maximumDrawdown - EPSILON) {
      maximumDrawdown = drawdown
      maximumPeakDate = runningPeakDate
      maximumTroughDate = point.date
      maximumPeakIndex = runningPeak
    }
  }

  const troughIndex = points.findIndex((point) => point.date === maximumTroughDate)
  let recoveryDate: string | null = maximumDrawdown === 0 ? maximumPeakDate : null
  if (maximumDrawdown < 0 && troughIndex >= 0) {
    for (let index = troughIndex + 1; index < points.length; index += 1) {
      if ((points[index].growthIndex ?? 0) + EPSILON >= maximumPeakIndex) {
        recoveryDate = points[index].date
        break
      }
    }
  }

  const finalPoint = points.at(-1)!
  const currentDrawdown = finalPoint.drawdown ?? 0
  const currentPeakDate = (() => {
    let peakValue = points[0].growthIndex ?? 1
    let peakDate = points[0].date
    for (const point of points) {
      const pointGrowthIndex = point.growthIndex ?? 0
      if (pointGrowthIndex + EPSILON >= peakValue) {
        peakValue = Math.max(peakValue, pointGrowthIndex)
        peakDate = point.date
      }
    }
    return peakDate
  })()

  const cumulativeTwr = clean((finalPoint.growthIndex ?? 1) - 1)
  let annualizedTwr: number | null = null
  if (dayCount !== null && dayCount > 0) {
    annualizedTwr = (1 + cumulativeTwr) <= EPSILON
      ? -1
      : clean(Math.pow(1 + cumulativeTwr, 365 / dayCount) - 1)
  }

  const declineDays = daysBetween(maximumPeakDate, maximumTroughDate)
  const recoveryDays = recoveryDate ? daysBetween(maximumTroughDate, recoveryDate) : null
  const underwaterEndDate = recoveryDate ?? endDate!
  const underwaterDays = daysBetween(maximumPeakDate, underwaterEndDate)
  const currentlyInDrawdown = currentDrawdown < -EPSILON

  return {
    complete: true,
    startDate,
    endDate,
    dayCount,
    cumulativeTwr,
    annualizedTwr,
    points,
    drawdown: {
      maximumDrawdown: clean(maximumDrawdown),
      peakDate: maximumPeakDate,
      troughDate: maximumTroughDate,
      declineDays,
      recoveryDate,
      recoveryDays,
      underwaterDays,
      currentDrawdown: clean(currentDrawdown),
      currentlyInDrawdown,
      currentPeakDate,
      currentUnderwaterDays: currentlyInDrawdown ? daysBetween(currentPeakDate, endDate!) : 0,
    },
    issues: [],
    blockingIssueCount: 0,
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function requiredObservationDates(
  requestedDates: string[],
  transactions: NormalizedTransaction[],
): string[] {
  const validRequested = requestedDates.map((date) => date.trim()).filter(isIsoDate).sort()
  if (validRequested.length === 0) return []
  const start = validRequested[0]
  const end = validRequested.at(-1)!
  const dates = new Set(validRequested)

  for (const row of transactions) {
    if (
      (row.transactionType === 'CASH_IN' || row.transactionType === 'CASH_OUT')
      && row.tradeDate >= start
      && row.tradeDate <= end
    ) {
      dates.add(row.tradeDate)
    }
  }
  return [...dates].sort()
}

export function buildHistoricalPerformanceSeries(
  input: HistoricalPerformanceInput,
): HistoricalPerformanceSeries {
  const {
    transactionRevision,
    valuationRevision,
    valuationSnapshotId,
    valuationDate,
    totalReturnCoverage,
    ...navInput
  } = input
  const observationDates = requiredObservationDates(navInput.dates, navInput.transactions)
  const navSeries = buildHistoricalNavSeries({ ...navInput, dates: observationDates })
  const observations: TwrObservation[] = navSeries.points.map((point) => ({
    date: point.asOfDate,
    complete: point.complete,
    totalAssetsTwd: point.totalAssetsTwd,
    contributionTwd: point.contributionTwdOnDate,
    withdrawalTwd: point.withdrawalTwdOnDate,
  }))

  let performance = calculateTimeWeightedPerformance(observations)
  if (totalReturnCoverage === 'PRICE_ONLY') {
    const coverageIssue: HistoricalPerformanceIssue = {
      code: 'UNSUPPORTED_TOTAL_RETURN_COVERAGE',
      message: '目前尚未納入股息、股票／ETF 分割及其他公司行動；市值曲線可供檢視，但不能宣稱為完整 TWR 或回撤',
      dates: observationDates,
    }
    performance = {
      ...performance,
      complete: false,
      cumulativeTwr: null,
      annualizedTwr: null,
      points: performance.points.map((point) => ({
        ...point,
        periodReturn: null,
        growthIndex: null,
        cumulativeTwr: null,
        runningPeakIndex: null,
        drawdown: null,
      })),
      drawdown: emptyDrawdown(),
      issues: [...performance.issues, coverageIssue],
      blockingIssueCount: performance.blockingIssueCount + 1,
    }
  }

  return {
    requestedDates: [...navInput.dates],
    observationDates,
    navSeries,
    performance,
    provenance: {
      transactionRevision,
      valuationRevision,
      valuationSnapshotId,
      valuationDate,
      calculationVersion: HISTORICAL_PERFORMANCE_CALCULATION_VERSION,
    },
  }
}
