import type { NormalizedTransaction } from './contracts'
import { findXirrRoots } from './performance'
import type {
  StrategyAllocation,
  StrategyComparisonRequest,
  StrategyExecution,
  StrategyIssue,
  StrategyMode,
  StrategySimulationResult,
  StrategyCurvePoint,
} from './strategy-comparison-contracts'

const EPSILON = 1e-9

export type StrategyPricePoint = {
  date: string
  totalReturnPriceTwd: number
}

export type StrategyPriceSeries = {
  ticker: string
  points: StrategyPricePoint[]
}

type ReplayFlow = {
  requestedDate: string
  kind: 'CONTRIBUTION' | 'WITHDRAWAL'
  amountTwd: number
  sourceRowNumbers: number[]
  order: number
}

type InternalEvent = ReplayFlow & {
  executionDate: string
}

type SimulationInput = {
  mode: StrategyMode
  allocations: StrategyAllocation[]
  commonDates: string[]
  priceByTickerAndDate: Map<string, Map<string, number>>
  flows: ReplayFlow[]
}

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

function utcTime(value: string): number {
  return Date.parse(`${value}T00:00:00Z`)
}

function daysBetween(start: string, end: string): number {
  return Math.round((utcTime(end) - utcTime(start)) / 86_400_000)
}

function validPrice(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

function monthDate(startDate: string, offset: number): string {
  const start = new Date(`${startDate}T00:00:00Z`)
  const anchorDay = start.getUTCDate()
  const firstOfMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1))
  const lastDay = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth() + 1, 0)).getUTCDate()
  firstOfMonth.setUTCDate(Math.min(anchorDay, lastDay))
  return firstOfMonth.toISOString().slice(0, 10)
}

export function buildMonthlySchedule(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  for (let offset = 0; offset < 1_200; offset += 1) {
    const date = monthDate(startDate, offset)
    if (date > endDate) break
    dates.push(date)
  }
  return dates
}

function lowerBound(values: string[], target: string): number {
  let left = 0
  let right = values.length
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (values[middle] < target) left = middle + 1
    else right = middle
  }
  return left
}

function nextCommonTradingDate(commonDates: string[], requestedDate: string): string | null {
  const index = lowerBound(commonDates, requestedDate)
  return commonDates[index] ?? null
}

function buildPriceMaps(
  allocations: StrategyAllocation[],
  priceSeries: StrategyPriceSeries[],
  startDate: string,
  endDate: string,
): {
  commonDates: string[]
  priceByTickerAndDate: Map<string, Map<string, number>>
  issues: StrategyIssue[]
} {
  const issues: StrategyIssue[] = []
  const seriesByTicker = new Map(priceSeries.map((series) => [series.ticker.toUpperCase(), series]))
  const priceByTickerAndDate = new Map<string, Map<string, number>>()
  let common: Set<string> | null = null

  for (const allocation of allocations) {
    const ticker = allocation.ticker.toUpperCase()
    const series = seriesByTicker.get(ticker)
    if (!series) {
      issues.push({
        code: 'MISSING_PRICE_SERIES',
        severity: 'BLOCKING',
        message: `${ticker} 沒有可用的策略行情`,
        sourceRowNumbers: [],
      })
      continue
    }
    const map = new Map<string, number>()
    for (const point of series.points) {
      if (point.date < startDate || point.date > endDate || !validPrice(point.totalReturnPriceTwd)) continue
      map.set(point.date, point.totalReturnPriceTwd)
    }
    if (map.size === 0) {
      issues.push({
        code: 'EMPTY_PRICE_SERIES',
        severity: 'BLOCKING',
        message: `${ticker} 在比較期間沒有可用的 total-return proxy 行情`,
        sourceRowNumbers: [],
      })
      continue
    }
    priceByTickerAndDate.set(ticker, map)
    const dates = new Set(map.keys())
    common = common === null ? dates : new Set([...common].filter((date) => dates.has(date)))
  }

  const commonDates = [...(common ?? new Set<string>())].sort()
  if (issues.length === 0 && commonDates.length === 0) {
    issues.push({
      code: 'NO_COMMON_TRADING_DATE',
      severity: 'BLOCKING',
      message: '所選標的在比較期間沒有共同可執行的交易日',
      sourceRowNumbers: [],
    })
  }
  return { commonDates, priceByTickerAndDate, issues }
}

export function deriveTransactionReplayFlows(
  transactions: NormalizedTransaction[],
  startDate: string,
  endDate: string,
): { flows: ReplayFlow[]; issues: StrategyIssue[] } {
  const flows: ReplayFlow[] = []
  const issues: StrategyIssue[] = []
  const rows = [...transactions]
    .filter((row) => row.transactionType === 'SECURITY' && row.tradeDate >= startDate && row.tradeDate <= endDate)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.sourceRowNumber - b.sourceRowNumber)

  for (const row of rows) {
    const rate = row.currency === 'TWD' ? 1 : row.fxRate
    if (rate === null || !Number.isFinite(rate) || rate <= 0) {
      issues.push({
        code: 'MISSING_REPLAY_FX',
        severity: 'BLOCKING',
        message: `第 ${row.sourceRowNumber} 列 ${row.currency} 證券交易缺少交易日匯率，無法重播`,
        sourceRowNumbers: [row.sourceRowNumber],
      })
      continue
    }
    const grossNative = row.amountForeign > 0
      ? row.amountForeign
      : Math.abs(row.quantity) * row.price
    const contribution = row.quantity > 0
    const netNative = contribution ? grossNative + row.fee : grossNative - row.fee
    if (!Number.isFinite(netNative) || (contribution ? netNative <= 0 : netNative < 0)) {
      issues.push({
        code: 'INVALID_REPLAY_AMOUNT',
        severity: 'BLOCKING',
        message: `第 ${row.sourceRowNumber} 列證券交易金額無法安全轉成 Transaction Replay 現金流`,
        sourceRowNumbers: [row.sourceRowNumber],
      })
      continue
    }
    if (!contribution && netNative === 0) continue
    flows.push({
      requestedDate: row.tradeDate,
      kind: contribution ? 'CONTRIBUTION' : 'WITHDRAWAL',
      amountTwd: clean(netNative * rate),
      sourceRowNumbers: [row.sourceRowNumber],
      order: row.sourceRowNumber,
    })
  }

  if (rows.length === 0) {
    issues.push({
      code: 'NO_REPLAY_TRANSACTIONS',
      severity: 'BLOCKING',
      message: '比較期間沒有證券買賣可供 Transaction Replay 使用',
      sourceRowNumbers: [],
    })
  }
  return { flows, issues }
}

function emptyResult(mode: StrategyMode, issues: StrategyIssue[]): StrategySimulationResult {
  return {
    mode,
    status: 'INCOMPLETE',
    startDate: null,
    endDate: null,
    grossContributionsTwd: 0,
    grossWithdrawalsTwd: 0,
    terminalValueTwd: null,
    estimatedGainTwd: null,
    moneyMultiple: null,
    xirr: null,
    cumulativeTwr: null,
    annualizedTwr: null,
    maximumDrawdown: null,
    recoveryDate: null,
    executionCount: 0,
    executions: [],
    curve: [],
    issues,
  }
}

function simulateStrategy(input: SimulationInput): StrategySimulationResult {
  const issues: StrategyIssue[] = []
  if (input.commonDates.length === 0) {
    return emptyResult(input.mode, [{
      code: 'NO_COMMON_TRADING_DATE',
      severity: 'BLOCKING',
      message: '沒有共同交易日可執行策略',
      sourceRowNumbers: [],
    }])
  }

  const events: InternalEvent[] = []
  for (const flow of input.flows) {
    const executionDate = nextCommonTradingDate(input.commonDates, flow.requestedDate)
    if (!executionDate) {
      issues.push({
        code: 'REPLAY_EVENT_AFTER_LAST_MARKET_DATE',
        severity: 'BLOCKING',
        message: `${flow.requestedDate} 的${flow.kind === 'CONTRIBUTION' ? '投入' : '賣出'}在比較終點前沒有共同交易日可執行`,
        sourceRowNumbers: flow.sourceRowNumbers,
      })
      continue
    }
    events.push({ ...flow, executionDate })
  }
  if (issues.length > 0 || events.length === 0) {
    if (events.length === 0 && issues.length === 0) {
      issues.push({ code: 'NO_EXECUTABLE_FLOW', severity: 'BLOCKING', message: '沒有可執行的策略現金流', sourceRowNumbers: [] })
    }
    return emptyResult(input.mode, issues)
  }
  events.sort((a, b) => a.executionDate.localeCompare(b.executionDate) || a.order - b.order)

  const holdings = new Map<string, number>(input.allocations.map((item) => [item.ticker.toUpperCase(), 0]))
  const eventsByDate = new Map<string, InternalEvent[]>()
  for (const event of events) {
    const list = eventsByDate.get(event.executionDate) ?? []
    list.push(event)
    eventsByDate.set(event.executionDate, list)
  }

  const firstExecutionDate = events[0].executionDate
  const startIndex = lowerBound(input.commonDates, firstExecutionDate)
  const curve: StrategyCurvePoint[] = []
  const executions: StrategyExecution[] = []
  let grossContributionsTwd = 0
  let grossWithdrawalsTwd = 0
  let blocked = false
  let previousPostFlowValue: number | null = null
  let growthIndex = 1
  let runningPeakIndex = 1
  let runningPeakDate = firstExecutionDate
  let maximumDrawdown = 0
  let maximumDrawdownPeakIndex = 1
  let maximumDrawdownTroughDate: string | null = null

  const valueAt = (date: string): number => input.allocations.reduce((total, allocation) => {
    const ticker = allocation.ticker.toUpperCase()
    const price = input.priceByTickerAndDate.get(ticker)?.get(date)
    const units = holdings.get(ticker) ?? 0
    return total + (validPrice(price) ? units * price : 0)
  }, 0)

  for (let index = startIndex; index < input.commonDates.length; index += 1) {
    const date = input.commonDates[index]
    const preFlowValue = clean(valueAt(date))

    if (previousPostFlowValue !== null) {
      if (previousPostFlowValue > EPSILON) {
        const growthFactor = preFlowValue / previousPostFlowValue
        if (!Number.isFinite(growthFactor) || growthFactor <= 0) {
          issues.push({
            code: 'INVALID_UNITIZED_RETURN',
            severity: 'BLOCKING',
            message: `${date} 的 cash-flow 前資產價值無法形成有效的 unitized return`,
            sourceRowNumbers: [],
          })
          blocked = true
          break
        }
        growthIndex *= growthFactor
      } else if (preFlowValue > EPSILON) {
        issues.push({
          code: 'UNEXPLAINED_VALUE_AFTER_ZERO_NAV',
          severity: 'BLOCKING',
          message: `${date} 在前一觀察點零資產後出現非零資產，無法安全串接 TWR`,
          sourceRowNumbers: [],
        })
        blocked = true
        break
      }
    }

    if (growthIndex > runningPeakIndex) {
      runningPeakIndex = growthIndex
      runningPeakDate = date
    }
    const drawdown = clean(growthIndex / runningPeakIndex - 1)
    if (drawdown < maximumDrawdown) {
      maximumDrawdown = drawdown
      maximumDrawdownPeakIndex = runningPeakIndex
      maximumDrawdownTroughDate = date
    }

    for (const event of eventsByDate.get(date) ?? []) {
      if (event.kind === 'CONTRIBUTION') {
        for (const allocation of input.allocations) {
          const ticker = allocation.ticker.toUpperCase()
          const price = input.priceByTickerAndDate.get(ticker)?.get(date)
          if (!validPrice(price)) {
            issues.push({ code: 'MISSING_EXECUTION_PRICE', severity: 'BLOCKING', message: `${ticker} ${date} 缺少執行價格`, sourceRowNumbers: event.sourceRowNumbers })
            blocked = true
            break
          }
          const allocated = event.amountTwd * allocation.weight
          holdings.set(ticker, (holdings.get(ticker) ?? 0) + allocated / price)
        }
        if (blocked) break
        grossContributionsTwd += event.amountTwd
      } else {
        const portfolioValue = valueAt(date)
        if (!Number.isFinite(portfolioValue) || portfolioValue + EPSILON < event.amountTwd) {
          issues.push({
            code: 'REPLAY_WITHDRAWAL_EXCEEDS_VALUE',
            severity: 'BLOCKING',
            message: `${date} Transaction Replay 要收回 ${event.amountTwd.toFixed(2)} 元，但模擬投組當時只有 ${portfolioValue.toFixed(2)} 元`,
            sourceRowNumbers: event.sourceRowNumbers,
          })
          blocked = true
          break
        }
        if (portfolioValue > EPSILON && event.amountTwd > EPSILON) {
          for (const allocation of input.allocations) {
            const ticker = allocation.ticker.toUpperCase()
            const price = input.priceByTickerAndDate.get(ticker)?.get(date)
            if (!validPrice(price)) continue
            const units = holdings.get(ticker) ?? 0
            const assetValue = units * price
            const saleValue = event.amountTwd * (assetValue / portfolioValue)
            holdings.set(ticker, Math.max(0, units - saleValue / price))
          }
        }
        grossWithdrawalsTwd += event.amountTwd
      }
      executions.push({
        requestedDate: event.requestedDate,
        executionDate: event.executionDate,
        kind: event.kind,
        amountTwd: event.amountTwd,
        sourceRowNumbers: event.sourceRowNumbers,
      })
    }
    if (blocked) break

    const postFlowValue = clean(valueAt(date))
    curve.push({
      date,
      totalAssetsTwd: postFlowValue,
      cumulativeTwr: clean(growthIndex - 1),
      growthIndex,
      drawdown,
    })
    previousPostFlowValue = postFlowValue
  }

  if (blocked || curve.length === 0) return emptyResult(input.mode, issues)
  const terminal = curve.at(-1)!
  const terminalValueTwd = terminal.totalAssetsTwd
  const estimatedGainTwd = clean(terminalValueTwd + grossWithdrawalsTwd - grossContributionsTwd)
  const moneyMultiple = grossContributionsTwd > EPSILON
    ? (terminalValueTwd + grossWithdrawalsTwd) / grossContributionsTwd
    : null

  let xirr: number | null = null
  if (grossContributionsTwd <= EPSILON) {
    issues.push({ code: 'NO_CONTRIBUTION', severity: 'BLOCKING', message: '策略沒有正的投入資金，XIRR 無法定義', sourceRowNumbers: [] })
  } else {
    const byDate = new Map<string, number>()
    for (const execution of executions) {
      const signed = execution.kind === 'CONTRIBUTION' ? -execution.amountTwd : execution.amountTwd
      byDate.set(execution.executionDate, (byDate.get(execution.executionDate) ?? 0) + signed)
    }
    byDate.set(terminal.date, (byDate.get(terminal.date) ?? 0) + terminalValueTwd)
    const xirrFlows = [...byDate.entries()]
      .map(([date, amount]) => ({ date, amount: clean(amount) }))
      .filter((flow) => Math.abs(flow.amount) > EPSILON)
      .sort((a, b) => a.date.localeCompare(b.date))
    if (xirrFlows.length < 2 || xirrFlows[0].date === xirrFlows.at(-1)?.date) {
      issues.push({ code: 'ZERO_TIME_SPAN', severity: 'BLOCKING', message: '策略現金流沒有足夠時間跨度，無法年化 XIRR', sourceRowNumbers: [] })
    } else {
      const roots = findXirrRoots(xirrFlows)
      if (roots.length === 1) xirr = roots[0]
      else if (roots.length === 0) issues.push({ code: 'XIRR_NOT_FOUND', severity: 'BLOCKING', message: '找不到唯一的 XIRR 解', sourceRowNumbers: [] })
      else issues.push({ code: 'MULTIPLE_XIRR_ROOTS', severity: 'BLOCKING', message: `策略現金流存在 ${roots.length} 個 XIRR 解`, sourceRowNumbers: [] })
    }
  }

  const startDate = curve[0]?.date ?? null
  const endDate = terminal.date
  const dayCount = startDate ? daysBetween(startDate, endDate) : 0
  const cumulativeTwr = clean(growthIndex - 1)
  const annualizedTwr = dayCount > 0 && growthIndex > 0
    ? Math.pow(growthIndex, 365 / dayCount) - 1
    : null
  if (dayCount <= 0) {
    issues.push({
      code: 'TWR_ZERO_TIME_SPAN',
      severity: 'BLOCKING',
      message: '策略績效沒有正的時間跨度，無法年化 TWR',
      sourceRowNumbers: [],
    })
  }
  const recoveryDate = maximumDrawdownTroughDate === null
    ? null
    : curve.find((point) =>
      point.date > maximumDrawdownTroughDate!
      && point.growthIndex !== null
      && point.growthIndex + EPSILON >= maximumDrawdownPeakIndex,
    )?.date ?? null

  return {
    mode: input.mode,
    status: issues.some((issue) => issue.severity === 'BLOCKING') ? 'INCOMPLETE' : 'ESTIMATED',
    startDate,
    endDate,
    grossContributionsTwd: clean(grossContributionsTwd),
    grossWithdrawalsTwd: clean(grossWithdrawalsTwd),
    terminalValueTwd: clean(terminalValueTwd),
    estimatedGainTwd,
    moneyMultiple,
    xirr,
    cumulativeTwr,
    annualizedTwr,
    maximumDrawdown,
    recoveryDate,
    executionCount: executions.length,
    executions,
    curve,
    issues,
  }
}

export function buildStrategyComparisonCore(input: {
  request: StrategyComparisonRequest
  priceSeries: StrategyPriceSeries[]
  transactions: NormalizedTransaction[]
}): {
  dca: StrategySimulationResult
  lumpSum: StrategySimulationResult
  transactionReplay: StrategySimulationResult
  lumpSumPrincipalTwd: number
} {
  const allocations = input.request.allocations.map((item) => ({
    ticker: item.ticker.trim().toUpperCase(),
    weight: item.weight,
  }))
  const market = buildPriceMaps(
    allocations,
    input.priceSeries,
    input.request.startDate,
    input.request.endDate,
  )
  if (market.issues.length > 0) {
    return {
      dca: emptyResult('DCA', market.issues),
      lumpSum: emptyResult('LUMP_SUM', market.issues),
      transactionReplay: emptyResult('TRANSACTION_REPLAY', market.issues),
      lumpSumPrincipalTwd: 0,
    }
  }

  const dcaFlows = buildMonthlySchedule(input.request.startDate, input.request.endDate)
    .map((requestedDate, order) => {
      const executionDate = nextCommonTradingDate(market.commonDates, requestedDate)
      if (!executionDate) return null
      return {
        requestedDate,
        kind: 'CONTRIBUTION' as const,
        amountTwd: input.request.dcaMonthlyAmountTwd,
        sourceRowNumbers: [],
        order,
      }
    })
    .filter((flow): flow is ReplayFlow => flow !== null)
  const lumpSumPrincipalTwd = clean(dcaFlows.length * input.request.dcaMonthlyAmountTwd)
  const lumpFlows: ReplayFlow[] = lumpSumPrincipalTwd > EPSILON ? [{
    requestedDate: input.request.startDate,
    kind: 'CONTRIBUTION',
    amountTwd: lumpSumPrincipalTwd,
    sourceRowNumbers: [],
    order: 0,
  }] : []
  const replay = deriveTransactionReplayFlows(
    input.transactions,
    input.request.startDate,
    input.request.endDate,
  )

  const dca = simulateStrategy({
    mode: 'DCA', allocations, commonDates: market.commonDates,
    priceByTickerAndDate: market.priceByTickerAndDate, flows: dcaFlows,
  })
  const lumpSum = simulateStrategy({
    mode: 'LUMP_SUM', allocations, commonDates: market.commonDates,
    priceByTickerAndDate: market.priceByTickerAndDate, flows: lumpFlows,
  })
  const transactionReplay = replay.issues.length > 0
    ? emptyResult('TRANSACTION_REPLAY', replay.issues)
    : simulateStrategy({
      mode: 'TRANSACTION_REPLAY', allocations, commonDates: market.commonDates,
      priceByTickerAndDate: market.priceByTickerAndDate, flows: replay.flows,
    })

  return { dca, lumpSum, transactionReplay, lumpSumPrincipalTwd }
}
