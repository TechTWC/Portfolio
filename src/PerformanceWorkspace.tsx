import { useEffect, useMemo, useState } from 'react'
import { api } from './lib/api'
import { buildCurrentPerformance } from './lib/performance'
import type { ValuationBootstrapResponse } from './lib/valuation-contracts'

function formatAmount(value: number | null): string {
  if (value === null) return '—'
  return value.toLocaleString('zh-TW', { maximumFractionDigits: 2 })
}

function formatPercent(value: number | null): string {
  if (value === null) return '—'
  return `${(value * 100).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
}

function formatMultiple(value: number | null): string {
  if (value === null) return '—'
  return `${value.toLocaleString('zh-TW', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}x`
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="metric-card">
      <p>{label}</p>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </article>
  )
}

const KIND_LABEL = {
  CONTRIBUTION: '外部投入',
  WITHDRAWAL: '外部出金',
  TERMINAL_VALUE: '期末總資產',
} as const

export default function PerformanceWorkspace() {
  const [valuation, setValuation] = useState<ValuationBootstrapResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.valuationBootstrap()
      .then(setValuation)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)))
  }, [])

  const result = useMemo(() => buildCurrentPerformance({
    transactions: valuation?.transactions ?? [],
    valuationDate: valuation?.activeSnapshot?.valuationDate ?? null,
    valuationComplete: valuation?.valuation?.complete ?? false,
    terminalAssetsTwd: valuation?.valuation?.totalAssetsTwd ?? null,
  }), [valuation])

  const loading = !valuation

  return (
    <section className="panel" id="performance-xirr">
      <div className="panel-heading"><div>
        <span>MONEY-WEIGHTED PERFORMANCE · v0.5</span>
        <h2>投資人資金報酬與 XIRR</h2>
        <p>CASH_IN、CASH_OUT 與期末總資產才是外部現金流；股票買賣及換匯是帳戶內活動，不會被重複算成投入或回收。</p>
      </div></div>

      {error && <div className="banner error">{error}</div>}
      {valuation?.freshness === 'STALE' && (
        <div className="banner error">
          XIRR 鎖定交易 v{valuation.activeSnapshot?.transactionRevision ?? '—'}；目前交易為 v{valuation.currentTransactionRevision}。結果可重現但已過期，重新啟用估值前請勿視為目前報酬。
        </div>
      )}
      {loading ? <div className="empty-state">正在載入交易與估值資料…</div> : (
        <>
          <div className="metrics-grid">
            <Metric
              label="績效狀態"
              value={valuation?.freshness === 'STALE' ? 'STALE' : result.complete ? '完整' : '不完整'}
              hint={valuation?.freshness === 'STALE' ? `綁定交易 v${valuation.activeSnapshot?.transactionRevision ?? '—'}` : result.complete ? '外部資金流與期末估值可年化' : `${result.blockingIssueCount} 項阻擋問題`}
            />
            <Metric label="績效截止日" value={result.valuationDate ?? '—'} hint="使用 ACTIVE 估值日" />
            <Metric label="累計投入" value={formatAmount(result.grossContributionsTwd)} hint="CASH_IN，以 TWD 換算" />
            <Metric label="累計出金" value={formatAmount(result.grossWithdrawalsTwd)} hint="CASH_OUT，以 TWD 換算" />
          </div>

          <div className="metrics-grid">
            <Metric label="淨投入本金" value={formatAmount(result.netContributedCapitalTwd)} hint="投入減出金，不是報酬率分母" />
            <Metric label="目前總資產" value={formatAmount(result.terminalAssetsTwd)} hint="ACTIVE Point-in-Time 估值" />
            <Metric label="累計損益" value={formatAmount(result.cumulativeProfitTwd)} hint="總資產＋出金－投入" />
            <Metric label="資金倍數" value={formatMultiple(result.moneyMultiple)} hint="不考慮資金投入時間" />
          </div>

          <div className="metrics-grid performance-xirr-highlight">
            <Metric label="年化 XIRR" value={formatPercent(result.xirr)} hint="Actual/365；投資人的資金加權報酬" />
            <Metric label="外部現金流事件" value={result.externalCashFlows.length.toLocaleString()} hint="內部買賣與換匯已排除" />
          </div>

          <div className="panel-heading"><div>
            <span>DATED EXTERNAL CASH FLOWS</span>
            <h2>XIRR 使用的現金流</h2>
            <p>投入顯示為負數；出金及期末資產顯示為正數。交易費用已反映在帳戶資產，不會再次加到外部現金流。</p>
          </div></div>

          {result.externalCashFlows.length === 0 ? <div className="empty-state">目前沒有可用的外部現金流。</div> : (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>日期</th><th>類型</th><th className="numeric">XIRR 現金流（TWD）</th><th>來源</th>
              </tr></thead>
              <tbody>{result.externalCashFlows.map((flow, index) => (
                <tr key={`${flow.date}-${flow.kind}-${index}`}>
                  <td>{flow.date}</td>
                  <td>{KIND_LABEL[flow.kind]}</td>
                  <td className="numeric">{formatAmount(flow.signedAmountTwd)}</td>
                  <td>{flow.sourceRowNumbers.length > 0 ? `交易列 ${flow.sourceRowNumbers.join(', ')}` : 'ACTIVE 估值 Snapshot'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}

          <div className="empty-state">
            XIRR 衡量投資人的資金加權年化報酬；尚未建立的 TWR、基準比較及最大回撤，不會由此數字替代。
          </div>

          {result.issues.length > 0 && (
            <div className="rejected-list">
              <strong>績效資料尚不能完整計算</strong>
              <ul>{result.issues.map((issue) => (
                <li key={`${issue.code}-${issue.sourceRowNumbers.join('-')}`}>
                  {issue.code}：{issue.message}
                  {issue.sourceRowNumbers.length > 0 ? `（交易列 ${issue.sourceRowNumbers.join(', ')}）` : ''}
                </li>
              ))}</ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
