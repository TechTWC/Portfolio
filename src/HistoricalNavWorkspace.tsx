import { useEffect, useMemo, useState } from 'react'
import { api } from './lib/api'
import { deriveHistoricalNavDates } from './lib/historical-nav-schedule'
import {
  buildHistoricalPerformanceSeries,
  type TwrPoint,
} from './lib/time-weighted-performance'
import type { ValuationBootstrapResponse } from './lib/valuation-contracts'
import { toValuationMark } from './lib/valuation-contracts'
import type { MarketDataBootstrapResponse } from './lib/market-data-contracts'
import { drawdownMetricPresentation } from './lib/drawdown-presentation'

function formatAmount(value: number | null): string {
  if (value === null) return '—'
  return value.toLocaleString('zh-TW', { maximumFractionDigits: 2 })
}

function formatPercent(value: number | null): string {
  if (value === null) return '—'
  return `${(value * 100).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
}

function formatIndex(value: number | null): string {
  if (value === null) return '—'
  return value.toLocaleString('zh-TW', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
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

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function LineChart({
  title,
  points,
  valueFor,
  formatValue,
  className,
}: {
  title: string
  points: TwrPoint[]
  valueFor: (point: TwrPoint) => number | null
  formatValue: (value: number | null) => string
  className: string
}) {
  const [range, setRange] = useState<'1M' | '3M' | 'YTD' | '1Y' | 'ALL'>('ALL')
  const [expanded, setExpanded] = useState(false)
  const allValid = points
    .map((point) => ({ date: point.date, value: valueFor(point) }))
    .filter((item): item is { date: string; value: number } => item.value !== null && Number.isFinite(item.value))

  const valid = useMemo(() => {
    const end = allValid.at(-1)?.date
    if (!end || range === 'ALL') return allValid
    const endDate = new Date(`${end}T00:00:00Z`)
    const cutoff = new Date(endDate)
    if (range === '1M') cutoff.setUTCMonth(cutoff.getUTCMonth() - 1)
    if (range === '3M') cutoff.setUTCMonth(cutoff.getUTCMonth() - 3)
    if (range === '1Y') cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1)
    if (range === 'YTD') cutoff.setUTCMonth(0, 1)
    const cutoffValue = cutoff.toISOString().slice(0, 10)
    return allValid.filter((item) => item.date >= cutoffValue)
  }, [allValid, range])

  useEffect(() => {
    if (!expanded) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [expanded])

  const width = 960
  const height = 210
  const paddingX = 34
  const paddingY = 26
  const values = valid.map((item) => item.value)
  const rawMin = values.length ? Math.min(...values) : 0
  const rawMax = values.length ? Math.max(...values) : 0
  const min = rawMin === rawMax ? rawMin - 0.01 : rawMin
  const max = rawMin === rawMax ? rawMax + 0.01 : rawMax
  const x = (index: number) => paddingX + (index / Math.max(1, valid.length - 1)) * (width - 2 * paddingX)
  const y = (value: number) => paddingY + ((max - value) / (max - min)) * (height - 2 * paddingY)
  const coordinates = valid.map((item, index) => `${x(index)},${y(item.value)}`).join(' ')

  const chart = (allowExpand: boolean) => (
    <>
      <div className="historical-chart-heading">
        <div><strong>{title}</strong><span>{valid.length ? `${valid[0].date} → ${valid.at(-1)?.date}` : '所選期間無完整資料'}</span></div>
        <div className="chart-actions">
          <div className="chart-range" aria-label="圖表期間">
            {(['1M', '3M', 'YTD', '1Y', 'ALL'] as const).map((item) => (
              <button key={item} type="button" className={range === item ? 'active' : ''} onClick={() => setRange(item)}>{item}</button>
            ))}
          </div>
          {allowExpand && <button className="chart-expand" type="button" onClick={() => setExpanded(true)} aria-label={`放大${title}`}>放大</button>}
        </div>
      </div>
      {valid.length < 2 ? <div className="empty-state">所選期間至少需要兩個完整計算點；可切換較長期間。</div> : <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        <line x1={paddingX} y1={paddingY} x2={paddingX} y2={height - paddingY} className="historical-chart-axis" />
        <line x1={paddingX} y1={height - paddingY} x2={width - paddingX} y2={height - paddingY} className="historical-chart-axis" />
        <polyline points={coordinates} className={className} />
        {valid.map((item, index) => (
          <circle key={`${title}-${item.date}`} cx={x(index)} cy={y(item.value)} r="4" className={`${className}-point`}>
            <title>{item.date}：{formatValue(item.value)}</title>
          </circle>
        ))}
        <text x={paddingX} y="18" className="historical-chart-label">{formatValue(max)}</text>
        <text x={paddingX} y={height - 6} className="historical-chart-label">{formatValue(min)}</text>
      </svg>}
    </>
  )

  return (
    <article className="historical-chart-card">
      {chart(true)}
      {expanded && (
        <div className="chart-dialog-backdrop" role="presentation" onMouseDown={() => setExpanded(false)}>
          <section className="chart-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
            <button className="chart-close" type="button" onClick={() => setExpanded(false)} aria-label="關閉放大圖表">關閉</button>
            {chart(false)}
          </section>
        </div>
      )}
    </article>
  )
}

export default function HistoricalNavWorkspace() {
  const [navPage, setNavPage] = useState(0)
  const [valuation, setValuation] = useState<ValuationBootstrapResponse | null>(null)
  const [marketData, setMarketData] = useState<MarketDataBootstrapResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.valuationBootstrap(), api.marketDataBootstrap()])
      .then(([nextValuation, nextMarketData]) => {
        setValuation(nextValuation)
        setMarketData(nextMarketData)
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)))
  }, [])

  const result = useMemo(() => {
    if (!valuation) return null
    const marks = marketData?.freshness === 'CURRENT' && marketData.marks.length > 0
      ? marketData.marks.map(toValuationMark)
      : valuation.marks.map(toValuationMark)
    const activeValuationDate = valuation.activeSnapshot?.valuationDate ?? null
    const dates = deriveHistoricalNavDates(
      marks,
      activeValuationDate,
      valuation.transactions,
    )
    return buildHistoricalPerformanceSeries({
      transactions: valuation.transactions,
      marks,
      dates,
      transactionRevision: valuation.activeSnapshot?.transactionRevision ?? 0,
      valuationRevision: valuation.valuationRevision,
      valuationSnapshotId: valuation.activeSnapshot?.id ?? null,
      valuationDate: activeValuationDate,
      totalReturnCoverage: 'PRICE_ONLY',
    })
  }, [valuation, marketData])

  const series = result?.navSeries ?? null
  const performance = result?.performance ?? null
  const provenance = result?.provenance ?? null
  const drawdownPresentation = performance
    ? drawdownMetricPresentation(performance.complete, performance.drawdown)
    : null
  const pointByDate = useMemo(
    () => new Map(series?.points.map((point) => [point.asOfDate, point]) ?? []),
    [series],
  )
  const navPageSize = 20
  const navPageCount = Math.max(1, Math.ceil((performance?.points.length ?? 0) / navPageSize))
  const safeNavPage = Math.min(navPage, navPageCount - 1)
  const visiblePerformancePoints = performance?.points.slice(
    safeNavPage * navPageSize,
    (safeNavPage + 1) * navPageSize,
  ) ?? []

  return (
    <section className="panel" id="historical-nav">
      <div className="panel-heading"><div>
        <span>HISTORICAL NAV · TWR · DRAWDOWN · v0.6</span>
        <h2>歷史資產、時間加權報酬與回撤</h2>
        <p>每個日期都重新播放當日以前的交易，並只使用當日或更早的價格與匯率。TWR 會排除外部入出金影響；最大回撤與目前回撤分開呈現。</p>
      </div></div>

      {error && <div className="banner error">{error}</div>}
      {valuation?.freshness === 'STALE' && (
        <div className="banner error">
          歷史績效鎖定交易 v{valuation.activeSnapshot?.transactionRevision ?? '—'}；目前交易為 v{valuation.currentTransactionRevision}。結果可重現但已過期，重新啟用估值前請勿視為目前績效。
        </div>
      )}
      {!series || !performance || !provenance ? <div className="empty-state">正在重建歷史 NAV 與績效…</div> : (
        <>
          <div className="metrics-grid">
            <Metric label="績效狀態" value={valuation?.freshness === 'STALE' ? 'STALE' : performance.complete ? '完整' : '待補資料'} hint={valuation?.freshness === 'STALE' ? `綁定交易 v${valuation.activeSnapshot?.transactionRevision ?? '—'}` : performance.complete ? 'NAV、TWR 與回撤可追溯' : `${performance.blockingIssueCount} 項績效阻擋問題`} />
            <Metric label="歷史觀察點" value={performance.points.length.toLocaleString()} hint="含期初、PRICE／FX 日期、外部資金流與 ACTIVE 估值日" />
            <Metric label="完整 NAV 點" value={series.completePointCount.toLocaleString()} />
            <Metric label="不完整 NAV 點" value={series.incompletePointCount.toLocaleString()} hint={series.incompletePointCount > 0 ? '缺少價格、匯率或帳務資料' : '所有觀察點可完整估值'} />
          </div>

          <details className="lineage-disclosure">
            <summary>資料來源與計算版本</summary>
            <p>
              交易 v{provenance.transactionRevision}｜估值 v{provenance.valuationRevision}
              ｜估值 Snapshot {provenance.valuationSnapshotId ?? '—'}
              ｜估值日 {provenance.valuationDate ?? '—'}
              ｜行情 {marketData?.activeRun ? `v${marketData.marketRevision} ${marketData.activeRun.provider}` : '估值檔'}
              ｜計算 {provenance.calculationVersion}
            </p>
          </details>

          <div className="banner warning">
            目前尚未納入股息、股票／ETF 分割及其他公司行動；下方只提供未還原收盤價計算的 TWD 市值曲線，不能視為完整總報酬、TWR 或回撤。
          </div>

          <div className="metrics-grid">
            <Metric label="累積 TWR" value={formatPercent(performance.cumulativeTwr)} hint="排除外部入出金後的幾何鏈結報酬" />
            <Metric label="年化 TWR" value={formatPercent(performance.annualizedTwr)} hint={performance.dayCount === null ? '—' : `Actual/365，共 ${performance.dayCount} 天`} />
            <Metric label="最大回撤" value={formatPercent(performance.drawdown.maximumDrawdown)} hint={performance.drawdown.peakDate && performance.drawdown.troughDate ? `${performance.drawdown.peakDate} → ${performance.drawdown.troughDate}` : '—'} />
            <Metric label="目前回撤" value={formatPercent(performance.drawdown.currentDrawdown)} hint={drawdownPresentation?.currentDrawdownHint} />
          </div>

          <div className="metrics-grid">
            <Metric label="最大回撤高點" value={performance.drawdown.peakDate ?? '—'} />
            <Metric label="最大回撤低點" value={performance.drawdown.troughDate ?? '—'} hint={performance.drawdown.declineDays === null ? undefined : `下跌歷時 ${performance.drawdown.declineDays} 天`} />
            <Metric label="修復日期" value={drawdownPresentation?.recoveryDateValue ?? '—'} hint={performance.drawdown.recoveryDays === null ? undefined : `低點後 ${performance.drawdown.recoveryDays} 天`} />
            <Metric label="水下期間" value={performance.drawdown.underwaterDays === null ? '—' : `${performance.drawdown.underwaterDays} 天`} hint={drawdownPresentation?.underwaterHint} />
          </div>

          <div className="historical-chart-grid">
            <LineChart
              title="投資組合 TWD 市值曲線（未含股息／公司行動）"
              points={performance.points}
              valueFor={(point) => point.totalAssetsTwd}
              formatValue={formatAmount}
              className="historical-chart-nav"
            />
            {performance.complete && (
              <>
              <LineChart
                title="TWR 累積淨值指數"
                points={performance.points}
                valueFor={(point) => point.growthIndex}
                formatValue={formatIndex}
                className="historical-chart-growth"
              />
              <LineChart
                title="回撤序列"
                points={performance.points}
                valueFor={(point) => point.drawdown}
                formatValue={formatPercent}
                className="historical-chart-drawdown"
              />
              </>
            )}
          </div>

          <div className="panel-heading"><div>
            <span>AUDITABLE NAV & RETURN CHAIN</span>
            <h2>歷史 NAV、外部資金流與區間報酬</h2>
            <p>當日投入視為期初資金，當日出金視為期末取回；因此單純入金或出金不會被誤認為投資報酬。</p>
          </div></div>

          {performance.points.length === 0 ? <div className="empty-state">目前沒有可用的歷史觀察日期。</div> : (
            <>
            <div className="table-wrap historical-desktop-table"><table>
              <thead><tr>
                <th>日期</th><th>狀態</th>
                <th className="numeric">TWD NAV</th>
                <th className="numeric">持倉市值</th>
                <th className="numeric">現金價值</th>
                <th className="numeric">當日投入</th>
                <th className="numeric">當日出金</th>
                <th className="numeric">單期報酬</th>
                <th className="numeric">累積 TWR</th>
                <th className="numeric">淨值指數</th>
                <th className="numeric">回撤</th>
                <th>價格／匯率日期</th><th>問題</th>
              </tr></thead>
              <tbody>{visiblePerformancePoints.map((point) => {
                const navPoint = pointByDate.get(point.date)
                return (
                  <tr key={point.date}>
                    <td>{point.date}</td>
                    <td>{point.complete ? '完整' : '不完整'}</td>
                    <td className="numeric">{formatAmount(point.totalAssetsTwd)}</td>
                    <td className="numeric">{formatAmount(navPoint?.positionValueTwd ?? null)}</td>
                    <td className="numeric">{formatAmount(navPoint?.cashValueTwd ?? null)}</td>
                    <td className="numeric">{formatAmount(point.contributionTwd)}</td>
                    <td className="numeric">{formatAmount(point.withdrawalTwd)}</td>
                    <td className="numeric">{formatPercent(point.periodReturn)}</td>
                    <td className="numeric">{formatPercent(point.cumulativeTwr)}</td>
                    <td className="numeric">{formatIndex(point.growthIndex)}</td>
                    <td className="numeric">{formatPercent(point.drawdown)}</td>
                    <td>{navPoint ? `${navPoint.latestPriceDateUsed ?? '—'}／${navPoint.latestFxDateUsed ?? '—'}` : '—'}</td>
                    <td>{navPoint?.issues.length ? navPoint.issues.map((issue) => issue.code).join('、') : '—'}</td>
                  </tr>
                )
              })}</tbody>
            </table></div>
            <div className="historical-mobile-list" aria-label="歷史 NAV 明細">
              {visiblePerformancePoints.map((point) => {
                const navPoint = pointByDate.get(point.date)
                return (
                  <details className="historical-mobile-row" key={`mobile-${point.date}`}>
                    <summary>
                      <span><strong>{point.date}</strong><small>{point.complete ? '完整' : '不完整'}</small></span>
                      <strong>{formatAmount(point.totalAssetsTwd)} TWD</strong>
                    </summary>
                    <dl>
                      <DetailValue label="持倉市值" value={formatAmount(navPoint?.positionValueTwd ?? null)} />
                      <DetailValue label="現金價值" value={formatAmount(navPoint?.cashValueTwd ?? null)} />
                      <DetailValue label="當日投入" value={formatAmount(point.contributionTwd)} />
                      <DetailValue label="當日出金" value={formatAmount(point.withdrawalTwd)} />
                      <DetailValue label="單期報酬" value={formatPercent(point.periodReturn)} />
                      <DetailValue label="累積 TWR" value={formatPercent(point.cumulativeTwr)} />
                      <DetailValue label="淨值指數" value={formatIndex(point.growthIndex)} />
                      <DetailValue label="回撤" value={formatPercent(point.drawdown)} />
                      <DetailValue label="價格／匯率日期" value={navPoint ? `${navPoint.latestPriceDateUsed ?? '—'}／${navPoint.latestFxDateUsed ?? '—'}` : '—'} />
                      <DetailValue label="問題" value={navPoint?.issues.length ? navPoint.issues.map((issue) => issue.code).join('、') : '—'} />
                    </dl>
                  </details>
                )
              })}
            </div>
            </>
          )}
          {performance.points.length > navPageSize && (
            <div className="pagination" aria-label="歷史 NAV 分頁">
              <button className="secondary compact" type="button" disabled={safeNavPage === 0} onClick={() => setNavPage((current) => Math.max(0, current - 1))}>上一頁</button>
              <span>第 {safeNavPage + 1}／{navPageCount} 頁 · 共 {performance.points.length.toLocaleString()} 筆</span>
              <button className="secondary compact" type="button" disabled={safeNavPage >= navPageCount - 1} onClick={() => setNavPage((current) => Math.min(navPageCount - 1, current + 1))}>下一頁</button>
            </div>
          )}

          {performance.issues.length > 0 && (
            <div className="rejected-list">
              <strong>歷史績效尚不能完整計算</strong>
              <ul>{performance.issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  <span>{issue.code}：{issue.message}</span>
                  {issue.dates.length > 0 && (
                    <details className="issue-disclosure">
                      <summary>查看 {issue.dates.length.toLocaleString()} 個受影響日期</summary>
                      <p>{issue.dates.join('、')}</p>
                    </details>
                  )}
                </li>
              ))}</ul>
            </div>
          )}

          {series.issues.length > 0 && (
            <div className="rejected-list">
              <strong>歷史 NAV 日期設定有問題</strong>
              <ul>{series.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.code}：{issue.message}</li>)}</ul>
            </div>
          )}

          <div className="empty-state">
            {marketData?.freshness === 'CURRENT' && marketData.marks.length > 0
              ? '本頁使用自動行情 v1 保存的每日 raw close 與匯率；SPY 基準已保存供後續策略比較，但尚未納入本頁報酬。'
              : '本頁使用目前估值 Snapshot 的歷史價格與匯率標記。觀察點越密集，回撤日期與修復期越精確。'}
          </div>
        </>
      )}
    </section>
  )
}
