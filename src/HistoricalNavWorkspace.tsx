import { useEffect, useMemo, useState } from 'react'
import { api } from './lib/api'
import type { BootstrapResponse } from './lib/contracts'
import { buildHistoricalNavSeries } from './lib/historical-nav'
import { deriveHistoricalNavDates } from './lib/historical-nav-schedule'
import type { ValuationBootstrapResponse } from './lib/valuation-contracts'
import { toValuationMark } from './lib/valuation-contracts'

function formatAmount(value: number | null): string {
  if (value === null) return '—'
  return value.toLocaleString('zh-TW', { maximumFractionDigits: 2 })
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

export default function HistoricalNavWorkspace() {
  const [transactions, setTransactions] = useState<BootstrapResponse | null>(null)
  const [valuation, setValuation] = useState<ValuationBootstrapResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.bootstrap(), api.valuationBootstrap()])
      .then(([transactionData, valuationData]) => {
        setTransactions(transactionData)
        setValuation(valuationData)
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)))
  }, [])

  const series = useMemo(() => {
    if (!transactions || !valuation) return null
    const marks = valuation.marks.map(toValuationMark)
    const dates = deriveHistoricalNavDates(marks, valuation.activeSnapshot?.valuationDate ?? null)
    return buildHistoricalNavSeries({ transactions: transactions.transactions, marks, dates })
  }, [transactions, valuation])

  const completePoints = series?.points.filter((point) => point.complete) ?? []
  const firstComplete = completePoints[0] ?? null
  const lastComplete = completePoints[completePoints.length - 1] ?? null
  const navChange = firstComplete?.totalAssetsTwd !== null
    && firstComplete?.totalAssetsTwd !== undefined
    && lastComplete?.totalAssetsTwd !== null
    && lastComplete?.totalAssetsTwd !== undefined
      ? lastComplete.totalAssetsTwd - firstComplete.totalAssetsTwd
      : null

  return (
    <section className="panel" id="historical-nav">
      <div className="panel-heading"><div>
        <span>HISTORICAL AS-OF NAV · v0.6</span>
        <h2>歷史 Point-in-Time 資產序列</h2>
        <p>每個日期都只重播當日以前的交易，並使用當日或更早的價格與匯率。這裡先驗證歷史 NAV 資料品質，尚未計算 TWR、CAGR 或最大回撤。</p>
      </div></div>

      {error && <div className="banner error">{error}</div>}
      {!series ? <div className="empty-state">正在重建歷史 NAV…</div> : (
        <>
          <div className="metrics-grid">
            <Metric label="歷史計算點" value={series.points.length.toLocaleString()} hint="由 PRICE 標記日期與 ACTIVE 估值日產生" />
            <Metric label="完整點數" value={series.completePointCount.toLocaleString()} />
            <Metric label="不完整點數" value={series.incompletePointCount.toLocaleString()} hint={series.incompletePointCount > 0 ? '不可進入 TWR 或回撤串接' : '所有歷史點可估值'} />
            <Metric label="資料狀態" value={series.incompletePointCount === 0 && series.issues.length === 0 ? '完整' : '待補資料'} />
          </div>

          <div className="metrics-grid">
            <Metric label="首個完整 NAV" value={formatAmount(firstComplete?.totalAssetsTwd ?? null)} hint={firstComplete?.asOfDate ?? '—'} />
            <Metric label="最新完整 NAV" value={formatAmount(lastComplete?.totalAssetsTwd ?? null)} hint={lastComplete?.asOfDate ?? '—'} />
            <Metric label="首末 NAV 變化" value={formatAmount(navChange)} hint="尚未排除期間外部資金流，不是 TWR" />
            <Metric label="ACTIVE 估值版本" value={valuation ? `v${valuation.valuationRevision}` : '—'} hint={valuation?.activeSnapshot?.filename ?? '尚未建立'} />
          </div>

          {series.points.length === 0 ? <div className="empty-state">目前沒有可用的歷史 PRICE 日期或 ACTIVE 估值日。</div> : (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>日期</th><th>狀態</th>
                <th className="numeric">納入交易</th>
                <th className="numeric">持倉市值</th>
                <th className="numeric">現金價值</th>
                <th className="numeric">TWD NAV</th>
                <th className="numeric">當日投入</th>
                <th className="numeric">當日出金</th>
                <th>最新價格日</th><th>最新匯率日</th><th>問題</th>
              </tr></thead>
              <tbody>{series.points.map((point) => (
                <tr key={point.asOfDate}>
                  <td>{point.asOfDate}</td>
                  <td>{point.complete ? '完整' : '不完整'}</td>
                  <td className="numeric">{point.transactionCount.toLocaleString()}</td>
                  <td className="numeric">{formatAmount(point.positionValueTwd)}</td>
                  <td className="numeric">{formatAmount(point.cashValueTwd)}</td>
                  <td className="numeric">{formatAmount(point.totalAssetsTwd)}</td>
                  <td className="numeric">{formatAmount(point.contributionTwdOnDate)}</td>
                  <td className="numeric">{formatAmount(point.withdrawalTwdOnDate)}</td>
                  <td>{point.latestPriceDateUsed ?? '—'}</td>
                  <td>{point.latestFxDateUsed ?? '—'}</td>
                  <td>{point.issues.length === 0 ? '—' : point.issues.map((issue) => issue.code).join('、')}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}

          {series.issues.length > 0 && (
            <div className="rejected-list">
              <strong>歷史 NAV 日期設定有問題</strong>
              <ul>{series.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.code}：{issue.message}</li>)}</ul>
            </div>
          )}

          <div className="empty-state">
            歷史 NAV 完整後，下一層才會依外部投入／出金切割子期間並鏈結 TWR；本頁的首末 NAV 變化不能直接當成時間加權報酬率。
          </div>
        </>
      )}
    </section>
  )
}
