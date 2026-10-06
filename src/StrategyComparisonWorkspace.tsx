import { useMemo, useState } from 'react'
import { api } from './lib/api'
import type { BootstrapResponse } from './lib/contracts'
import type {
  StrategyComparisonResponse,
  StrategySimulationResult,
} from './lib/strategy-comparison-contracts'

type AllocationRow = { ticker: string; weightPercent: string }

function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

function formatAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `NT$ ${value.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
}

function formatMultiple(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value.toLocaleString('zh-TW', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}x`
}

function strategyLabel(key: keyof StrategyComparisonResponse['strategies']): string {
  if (key === 'dca') return 'DCA 定期定額'
  if (key === 'lumpSum') return 'Lump Sum 一次投入'
  return 'Transaction Replay'
}

function issueSummary(result: StrategySimulationResult): string {
  return result.issues[0]?.message ?? (result.status === 'ESTIMATED' ? '可比較' : '資料不足')
}

export default function StrategyComparisonWorkspace({ bootstrap }: { bootstrap: BootstrapResponse }) {
  const [startDate, setStartDate] = useState(bootstrap.activeDataset?.earliestDate ?? '')
  const [endDate, setEndDate] = useState(todayLocal())
  const [monthlyAmount, setMonthlyAmount] = useState('70000')
  const [allocations, setAllocations] = useState<AllocationRow[]>([
    { ticker: '0050.TW', weightPercent: '100' },
  ])
  const [result, setResult] = useState<StrategyComparisonResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const weightTotal = useMemo(
    () => allocations.reduce((sum, row) => sum + (Number(row.weightPercent) || 0), 0),
    [allocations],
  )

  function updateAllocation(index: number, patch: Partial<AllocationRow>) {
    setAllocations((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row))
    setResult(null)
  }

  function addAllocation() {
    if (allocations.length >= 5) return
    setAllocations((current) => [...current, { ticker: '', weightPercent: '0' }])
    setResult(null)
  }

  function removeAllocation(index: number) {
    if (allocations.length <= 1) return
    setAllocations((current) => current.filter((_, rowIndex) => rowIndex !== index))
    setResult(null)
  }

  async function runComparison() {
    setError('')
    setResult(null)
    const amount = Number(monthlyAmount)
    const normalized = allocations.map((row) => ({
      ticker: row.ticker.trim().toUpperCase(),
      weight: Number(row.weightPercent) / 100,
    }))
    if (!startDate || !endDate || startDate > endDate) {
      setError('請確認比較起訖日。')
      return
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('DCA 每月投入金額必須大於 0。')
      return
    }
    if (normalized.some((row) => !row.ticker)) {
      setError('每一個配置列都必須填入標的代號。')
      return
    }
    if (Math.abs(weightTotal - 100) > 0.0001) {
      setError(`投資組合權重目前為 ${weightTotal.toFixed(2)}%，必須等於 100%。`)
      return
    }

    setBusy(true)
    try {
      setResult(await api.strategyComparison({
        startDate,
        endDate,
        dcaMonthlyAmountTwd: amount,
        allocations: normalized,
      }))
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError))
    } finally {
      setBusy(false)
    }
  }

  const strategyEntries = result
    ? (Object.entries(result.strategies) as Array<[keyof StrategyComparisonResponse['strategies'], StrategySimulationResult]>)
    : []

  return (
    <section className="panel" id="strategy-comparison">
      <div className="panel-heading"><div>
        <span>STRATEGY COMPARISON · v0.1</span>
        <h2>DCA、Lump Sum、Transaction Replay</h2>
        <p>同一組自訂標的與權重，一次比較三種資金投入路徑。DCA 與 Lump Sum 使用相同總本金；Transaction Replay 使用你的實際證券買賣日期與金額。</p>
      </div></div>

      {error && <div className="banner error">{error}</div>}
      <div className="banner warning">
        v0.1 使用 Yahoo adjusted close 作為總報酬代理，允許小數單位，且不計手續費、交易稅與滑價；結果屬策略模擬，不是券商帳戶正式績效。
      </div>

      <div className="strategy-controls">
        <label><span>開始日</span><input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setResult(null) }} /></label>
        <label><span>結束日</span><input type="date" value={endDate} onChange={(event) => { setEndDate(event.target.value); setResult(null) }} /></label>
        <label><span>DCA 每月投入（TWD）</span><input type="number" min="1" step="1000" value={monthlyAmount} onChange={(event) => { setMonthlyAmount(event.target.value); setResult(null) }} /></label>
      </div>

      <div className="panel-heading strategy-subheading"><div>
        <span>TARGET PORTFOLIO</span><h2>自訂投資組合</h2>
        <p>最多 5 檔，權重合計必須為 100%。台股請使用行情來源可辨識的代號，例如 0050.TW；上櫃標的例如 6488.TWO。</p>
      </div></div>
      <div className="table-wrap"><table>
        <thead><tr><th>標的</th><th className="numeric">權重 %</th><th>操作</th></tr></thead>
        <tbody>{allocations.map((row, index) => (
          <tr key={`allocation-${index}`}>
            <td><input className="strategy-table-input" value={row.ticker} placeholder="0050.TW" onChange={(event) => updateAllocation(index, { ticker: event.target.value })} /></td>
            <td className="numeric"><input className="strategy-table-input numeric" type="number" min="0.01" max="100" step="0.01" value={row.weightPercent} onChange={(event) => updateAllocation(index, { weightPercent: event.target.value })} /></td>
            <td><button type="button" className="secondary compact" disabled={allocations.length <= 1} onClick={() => removeAllocation(index)}>移除</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="strategy-actions">
        <span className={Math.abs(weightTotal - 100) <= 0.0001 ? 'positive-text' : ''}>權重合計 {weightTotal.toFixed(2)}%</span>
        <div>
          <button type="button" className="secondary" disabled={allocations.length >= 5} onClick={addAllocation}>新增標的</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void runComparison()}>{busy ? '計算中…' : '執行三策略比較'}</button>
        </div>
      </div>

      {result && <>
        <div className="metrics-grid strategy-summary">
          <article className="metric-card"><p>計算狀態</p><strong>{result.status}</strong><small>{result.calculationVersion}</small></article>
          <article className="metric-card"><p>DCA 每月投入</p><strong>{formatAmount(result.dcaMonthlyAmountTwd)}</strong><small>依開始日日號每月排程</small></article>
          <article className="metric-card"><p>Lump Sum 本金</p><strong>{formatAmount(result.lumpSumPrincipalTwd)}</strong><small>與 DCA 實際投入總本金相同</small></article>
          <article className="metric-card"><p>資料版本</p><strong>v{result.transactionRevision}</strong><small>{result.marketSource} · adjusted-close proxy</small></article>
        </div>

        <div className="table-wrap"><table>
          <thead><tr><th>指標</th>{strategyEntries.map(([key]) => <th className="numeric" key={key}>{strategyLabel(key)}</th>)}</tr></thead>
          <tbody>
            <tr><td>狀態</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key} title={issueSummary(value)}>{value.status}</td>)}</tr>
            <tr><td>總投入</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{formatAmount(value.grossContributionsTwd)}</td>)}</tr>
            <tr><td>總收回</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{formatAmount(value.grossWithdrawalsTwd)}</td>)}</tr>
            <tr><td>期末價值</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{formatAmount(value.terminalValueTwd)}</td>)}</tr>
            <tr><td>推估損益</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{formatAmount(value.estimatedGainTwd)}</td>)}</tr>
            <tr><td>Money Multiple</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{formatMultiple(value.moneyMultiple)}</td>)}</tr>
            <tr><td>XIRR</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{formatPercent(value.xirr)}</td>)}</tr>
            <tr><td>累積 TWR</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{formatPercent(value.cumulativeTwr)}</td>)}</tr>
            <tr><td>年化 TWR</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{formatPercent(value.annualizedTwr)}</td>)}</tr>
            <tr><td>最大回撤</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{formatPercent(value.maximumDrawdown)}</td>)}</tr>
            <tr><td>執行次數</td>{strategyEntries.map(([key, value]) => <td className="numeric" key={key}>{value.executionCount.toLocaleString()}</td>)}</tr>
          </tbody>
        </table></div>

        {strategyEntries.some(([, value]) => value.issues.length > 0) && (
          <div className="rejected-list">
            <strong>部分策略有資料或計算限制</strong>
            <ul>{strategyEntries.flatMap(([key, value]) => value.issues.map((issue, index) => (
              <li key={`${key}-${issue.code}-${index}`}>{strategyLabel(key)} · {issue.code}：{issue.message}</li>
            )))}</ul>
          </div>
        )}

        <details className="lineage-disclosure strategy-assumptions">
          <summary>計算假設與資料來源</summary>
          <p>{result.allocations.map((item) => `${item.ticker} ${(item.weight * 100).toFixed(2)}%`).join('｜')}</p>
          <ul>{result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
        </details>
      </>}
    </section>
  )
}
