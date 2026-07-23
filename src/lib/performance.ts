import type { NormalizedTransaction } from './contracts'

const DAY_MS = 86_400_000
const EPSILON = 1e-9

export type PerformanceIssueCode =
  | 'MISSING_VALUATION'
  | 'INCOMPLETE_VALUATION'
  | 'INVALID_VALUATION_DATE'
  | 'TRANSACTION_AFTER_VALUATION_DATE'
  | 'MISSING_EXTERNAL_FLOW_FX'
  | 'NO_CONTRIBUTION'
  | 'NO_POSITIVE_CASH_FLOW'
  | 'ZERO_TIME_SPAN'
  | 'XIRR_NOT_FOUND'
  | 'MULTIPLE_XIRR_ROOTS'

export type PerformanceIssue = {
  code: PerformanceIssueCode
  severity: 'BLOCKING'
  message: string
  sourceRowNumbers: number[]
}

export type ExternalCashFlowKind = 'CONTRIBUTION' | 'WITHDRAWAL' | 'TERMINAL_VALUE'

export type ExternalCashFlow = {
  date: string
  kind: ExternalCashFlowKind
  amountTwd: number
  signedAmountTwd: number
  sourceRowNumbers: number[]
}

export type CurrentPerformanceInput = {
  transactions: NormalizedTransaction[]
  valuationDate: string | null
  valuationComplete: boolean
  terminalAssetsTwd: number | null
}

export type CurrentPerformance = {
  valuationDate: string | null
  complete: boolean
  grossContributionsTwd: number
  grossWithdrawalsTwd: number
  netContributedCapitalTwd: number
  terminalAssetsTwd: number | null
  cumulativeProfitTwd: number | null
  moneyMultiple: number | null
  xirr: number | null
  externalCashFlows: ExternalCashFlow[]
  issues: PerformanceIssue[]
  blockingIssueCount: number
}

type DatedAmount = { date: string; amount: number }

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function utcTime(value: string): number {
  return Date.parse(`${value}T00:00:00Z`)
}

function aggregateXirrFlows(events: ExternalCashFlow[]): DatedAmount[] {
  const byDate = new Map<string, number>()
  for (const event of events) {
    byDate.set(event.date, (byDate.get(event.date) ?? 0) + event.signedAmountTwd)
  }
  return [...byDate.entries()]
    .map(([date, amount]) => ({ date, amount: clean(amount) }))
    .filter((flow) => Math.abs(flow.amount) > EPSILON)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function xnpvAtLogRate(logOnePlusRate: number, flows: DatedAmount[]): number {
  const firstTime = utcTime(flows[0].date)
  let total = 0
  for (const flow of flows) {
    const years = (utcTime(flow.date) - firstTime) / DAY_MS / 365
    total += flow.amount * Math.exp(-years * logOnePlusRate)
  }
  return total
}

function bisectRoot(
  flows: DatedAmount[],
  leftStart: number,
  rightStart: number,
  tolerance: number,
): number {
  let left = leftStart
  let right = rightStart
  let leftValue = xnpvAtLogRate(left, flows)

  for (let iteration = 0; iteration < 160; iteration += 1) {
    const middle = (left + right) / 2
    const middleValue = xnpvAtLogRate(middle, flows)
    if (Math.abs(middleValue) <= tolerance || Math.abs(right - left) <= 1e-13) return Math.expm1(middle)

    if ((leftValue < 0 && middleValue > 0) || (leftValue > 0 && middleValue < 0)) {
      right = middle
    } else {
      left = middle
      leftValue = middleValue
    }
  }

  return Math.expm1((left + right) / 2)
}

export function findXirrRoots(flows: DatedAmount[]): number[] {
  if (flows.length < 2) return []
  const scale = flows.reduce((total, flow) => total + Math.abs(flow.amount), 0)
  const tolerance = Math.max(1e-8, scale * 1e-11)
  const minLogRate = Math.log(1e-6) // rate = -0.999999
  const maxLogRate = Math.log(1_000_001) // rate = 1,000,000
  const steps = 1_600
  const roots: number[] = []

  const addRoot = (rate: number) => {
    if (!Number.isFinite(rate) || rate <= -1) return
    const duplicate = roots.some((existing) => Math.abs(existing - rate) <= 1e-7 * Math.max(1, Math.abs(rate)))
    if (!duplicate) roots.push(rate)
  }

  let previousLog = minLogRate
  let previousValue = xnpvAtLogRate(previousLog, flows)
  if (Math.abs(previousValue) <= tolerance) addRoot(Math.expm1(previousLog))

  for (let index = 1; index <= steps; index += 1) {
    const currentLog = minLogRate + ((maxLogRate - minLogRate) * index) / steps
    const currentValue = xnpvAtLogRate(currentLog, flows)

    if (Math.abs(currentValue) <= tolerance) addRoot(Math.expm1(currentLog))
    if (
      Number.isFinite(previousValue)
      && Number.isFinite(currentValue)
      && ((previousValue < 0 && currentValue > 0) || (previousValue > 0 && currentValue < 0))
    ) {
      addRoot(bisectRoot(flows, previousLog, currentLog, tolerance))
    }

    previousLog = currentLog
    previousValue = currentValue
  }

  return roots.sort((a, b) => a - b)
}

export function buildCurrentPerformance(input: CurrentPerformanceInput): CurrentPerformance {
  const issues: PerformanceIssue[] = []
  const events: ExternalCashFlow[] = []
  const valuationDate = input.valuationDate

  if (!valuationDate) {
    issues.push({
      code: 'MISSING_VALUATION',
      severity: 'BLOCKING',
      message: '尚未建立 ACTIVE 估值 Snapshot，無法計算期末資產與 XIRR',
      sourceRowNumbers: [],
    })
  } else if (!isIsoDate(valuationDate)) {
    issues.push({
      code: 'INVALID_VALUATION_DATE',
      severity: 'BLOCKING',
      message: '估值日不是有效的 YYYY-MM-DD',
      sourceRowNumbers: [],
    })
  }

  if (!input.valuationComplete || input.terminalAssetsTwd === null) {
    issues.push({
      code: 'INCOMPLETE_VALUATION',
      severity: 'BLOCKING',
      message: 'ACTIVE 估值不完整，不能把已知部分資產當成期末總資產',
      sourceRowNumbers: [],
    })
  }

  if (valuationDate && isIsoDate(valuationDate)) {
    const laterRows = input.transactions.filter((row) => row.tradeDate > valuationDate)
    if (laterRows.length > 0) {
      issues.push({
        code: 'TRANSACTION_AFTER_VALUATION_DATE',
        severity: 'BLOCKING',
        message: `有 ${laterRows.length} 筆交易晚於估值日；目前版本尚未建立完整歷史 as-of 持倉引擎`,
        sourceRowNumbers: laterRows.map((row) => row.sourceRowNumber).sort((a, b) => a - b),
      })
    }
  }

  for (const row of [...input.transactions].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber,
  )) {
    if (row.transactionType !== 'CASH_IN' && row.transactionType !== 'CASH_OUT') continue
    if (valuationDate && isIsoDate(valuationDate) && row.tradeDate > valuationDate) continue

    const rate = row.currency === 'TWD' ? 1 : row.fxRate
    if (rate === null || !Number.isFinite(rate) || rate <= 0) {
      issues.push({
        code: 'MISSING_EXTERNAL_FLOW_FX',
        severity: 'BLOCKING',
        message: `第 ${row.sourceRowNumber} 列 ${row.currency} ${row.transactionType} 缺少實際歷史匯率`,
        sourceRowNumbers: [row.sourceRowNumber],
      })
      continue
    }

    const amountTwd = row.amountForeign * rate
    const contribution = row.transactionType === 'CASH_IN'
    events.push({
      date: row.tradeDate,
      kind: contribution ? 'CONTRIBUTION' : 'WITHDRAWAL',
      amountTwd,
      signedAmountTwd: contribution ? -amountTwd : amountTwd,
      sourceRowNumbers: [row.sourceRowNumber],
    })
  }

  if (
    valuationDate
    && isIsoDate(valuationDate)
    && input.valuationComplete
    && input.terminalAssetsTwd !== null
    && Number.isFinite(input.terminalAssetsTwd)
    && input.terminalAssetsTwd >= 0
  ) {
    events.push({
      date: valuationDate,
      kind: 'TERMINAL_VALUE',
      amountTwd: input.terminalAssetsTwd,
      signedAmountTwd: input.terminalAssetsTwd,
      sourceRowNumbers: [],
    })
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
  const grossContributionsTwd = clean(events
    .filter((event) => event.kind === 'CONTRIBUTION')
    .reduce((total, event) => total + event.amountTwd, 0))
  const grossWithdrawalsTwd = clean(events
    .filter((event) => event.kind === 'WITHDRAWAL')
    .reduce((total, event) => total + event.amountTwd, 0))
  const terminalAssetsTwd = input.valuationComplete ? input.terminalAssetsTwd : null
  const netContributedCapitalTwd = clean(grossContributionsTwd - grossWithdrawalsTwd)
  const cumulativeProfitTwd = terminalAssetsTwd === null
    ? null
    : clean(terminalAssetsTwd + grossWithdrawalsTwd - grossContributionsTwd)
  const moneyMultiple = terminalAssetsTwd === null || grossContributionsTwd <= EPSILON
    ? null
    : (terminalAssetsTwd + grossWithdrawalsTwd) / grossContributionsTwd

  if (grossContributionsTwd <= EPSILON) {
    issues.push({
      code: 'NO_CONTRIBUTION',
      severity: 'BLOCKING',
      message: '沒有可辨識的外部投入資金，XIRR 無法定義',
      sourceRowNumbers: [],
    })
  }

  const flows = aggregateXirrFlows(events)
  if (!flows.some((flow) => flow.amount > EPSILON)) {
    issues.push({
      code: 'NO_POSITIVE_CASH_FLOW',
      severity: 'BLOCKING',
      message: '沒有提款或期末資產等正現金流，XIRR 無法定義',
      sourceRowNumbers: [],
    })
  }

  if (events.length >= 2 && events[0].date === events[events.length - 1].date) {
    issues.push({
      code: 'ZERO_TIME_SPAN',
      severity: 'BLOCKING',
      message: '所有外部現金流都在同一天，無法年化為 XIRR',
      sourceRowNumbers: [],
    })
  }

  let xirr: number | null = null
  const preXirrBlocking = issues.length > 0
  if (!preXirrBlocking) {
    const roots = findXirrRoots(flows)
    if (roots.length === 0) {
      issues.push({
        code: 'XIRR_NOT_FOUND',
        severity: 'BLOCKING',
        message: '在允許的利率區間內找不到 XIRR 解',
        sourceRowNumbers: [],
      })
    } else if (roots.length > 1) {
      issues.push({
        code: 'MULTIPLE_XIRR_ROOTS',
        severity: 'BLOCKING',
        message: `現金流存在 ${roots.length} 個 XIRR 解，系統不會任選其中一個`,
        sourceRowNumbers: [],
      })
    } else {
      xirr = roots[0]
    }
  }

  return {
    valuationDate,
    complete: issues.length === 0 && xirr !== null,
    grossContributionsTwd,
    grossWithdrawalsTwd,
    netContributedCapitalTwd,
    terminalAssetsTwd,
    cumulativeProfitTwd,
    moneyMultiple,
    xirr,
    externalCashFlows: events,
    issues,
    blockingIssueCount: issues.length,
  }
}
