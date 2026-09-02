import { useEffect, useMemo, useState } from 'react'
import { api } from './lib/api'
import { buildCurrentPerformance } from './lib/performance'
import { staleMarketDataMessage } from './lib/market-data-freshness'
import { buildSecurityInvestmentPerformance } from './lib/security-performance'
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

const SECURITY_KIND_LABEL = {
  PURCHASE: '證券買進',
  SALE: '證券賣出',
  TERMINAL_POSITION_VALUE: '期末持倉市值',
} as const

const OFFICIAL_KIND_LABEL = {
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

  const estimated = useMemo(() => buildSecurityInvestmentPerformance({
    transactions: valuation?.transactions ?? [],
    valuationDate: valuation?.activeSnapshot?.valuationDate ?? null,
    valuationComplete: valuation?.valuation?.complete ?? false,
    terminalPositionValueTwd: valuation?.valuation?.complete
      ? valuation.valuation.knownPositionValueTwd
      : null,
  }), [valuation])

  const official = useMemo(() => buildCurrentPerformance({
    transactions: valuation?.transactions ?? [],
    valuationDate: valuation?.activeSnapshot?.valuationDate ?? null,
    valuationComplete: valuation?.valuation?.complete ?? false,
    terminalAssetsTwd: valuation?.valuation?.totalAssetsTwd ?? null,
  }), [valuation])

  const loading = !valuation

  return (
    <section className="panel" id="performance-xirr">
      <div className="panel-heading"><div>
        <span>ESTIMATED SECURITY RETURN · v0.1</span>
        <h2>證券投入與推估 XIRR</h2>
        <p>依買賣紀錄估算證券資金的年化效率：買進為投入、賣出為回收，期末加入未平倉持股市值。</p>
      </div></div>

      <div className="banner info">
        <strong>這是明示推估，不是正式帳戶總報酬。</strong>
        <br />交割日先視為交易日；不推算銀行與證券帳戶轉帳。股息、股票／ETF 分割、其他公司行動及不精確的歷史匯率仍可能造成偏差。
      </div>

      {error && <div className="banner error">{error}</div>}
      {valuation?.freshness === 'STALE' && (
        <div className="banner error">
          {valuation.freshnessReason === 'TRANSACTION_VERSION'
            ? `XIRR 鎖定交易 v${valuation.activeSnapshot?.transactionRevision ?? '—'}；目前交易為 v${valuation.currentTransactionRevision}。結果可重現但已過期，重新啟用估值前請勿視為目前報酬。`
            : `${staleMarketDataMessage(valuation.activeSnapshot?.valuationDate, valuation.valuationAgeDays)}；XIRR 不得視為目前報酬。`}
        </div>
      )}
      {loading ? <div className="empty-state">正在載入交易與估值資料…</div> : (
        <>
          <div className="metrics-grid">
            <Metric
              label="推估狀態"
              value={valuation?.freshness === 'STALE' ? 'STALE' : estimated.complete ? '可計算' : '不完整'}
              hint={valuation?.freshness === 'STALE' ? (valuation.freshnessReason === 'TRANSACTION_VERSION' ? `綁定交易 v${valuation.activeSnapshot?.transactionRevision ?? '—'}` : `${valuation.valuationAgeDays ?? '—'} 天前`) : estimated.complete ? '買賣紀錄與期末持倉可年化' : `${estimated.blockingIssueCount} 項阻擋問題`}
            />
            <Metric label="推估截止日" value={estimated.valuationDate ?? '—'} hint="使用 ACTIVE 估值日" />
            <Metric label="累計買進" value={formatAmount(estimated.grossPurchasesTwd)} hint="交易金額＋費用，以 TWD 換算" />
            <Metric label="累計賣出回收" value={formatAmount(estimated.grossSaleProceedsTwd)} hint="交易金額－費用，以 TWD 換算" />
          </div>

          <div className="metrics-grid">
            <Metric label="淨證券投入" value={formatAmount(estimated.netSecurityCapitalDeployedTwd)} hint="累計買進－累計賣出回收" />
            <Metric label="目前持倉市值" value={formatAmount(estimated.terminalPositionValueTwd)} hint="不含無法確認來源的帳戶現金" />
            <Metric label="推估累計損益" value={formatAmount(estimated.estimatedGainTwd)} hint="持倉市值＋賣出回收－買進" />
            <Metric label="證券資金倍數" value={formatMultiple(estimated.securityMultiple)} hint="不考慮各次投入時間" />
          </div>

          <div className="metrics-grid performance-xirr-highlight">
            <Metric label="推估年化 XIRR" value={formatPercent(estimated.xirr)} hint="Actual/365；證券投入的資金加權年化效率" />
            <Metric label="證券現金流事件" value={estimated.securityCashFlows.length.toLocaleString()} hint="買進、賣出與期末持倉市值" />
          </div>

          <div className="panel-heading"><div>
            <span>ESTIMATED SECURITY CASH FLOWS</span>
            <h2>推估 XIRR 使用的證券現金流</h2>
            <p>買進顯示為負數；賣出淨收入及期末持倉市值顯示為正數。日期一律先採交易日。</p>
          </div></div>

          {estimated.securityCashFlows.length === 0 ? <div className="empty-state">目前沒有可用的證券現金流。</div> : (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>日期</th><th>類型</th><th className="numeric">推估 XIRR 現金流（TWD）</th><th>來源</th>
              </tr></thead>
              <tbody>{estimated.securityCashFlows.map((flow, index) => (
                <tr key={`${flow.date}-${flow.kind}-${index}`}>
                  <td>{flow.date}</td>
                  <td>{SECURITY_KIND_LABEL[flow.kind]}</td>
                  <td className="numeric">{formatAmount(flow.signedAmountTwd)}</td>
                  <td>{flow.sourceRowNumbers.length > 0 ? `交易列 ${flow.sourceRowNumbers.join(', ')}` : 'ACTIVE 持倉估值'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}

          <div className="empty-state">
            推估 XIRR 只衡量買賣紀錄所呈現的證券資金效率；不能替代完整總報酬、TWR、基準比較或最大回撤。
          </div>

          {estimated.issues.length > 0 && (
            <div className="rejected-list">
              <strong>推估績效尚不能完整計算</strong>
              <ul>{estimated.issues.map((issue) => (
                <li key={`${issue.code}-${issue.sourceRowNumbers.join('-')}`}>
                  {issue.code}：{issue.message}
                  {issue.sourceRowNumbers.length > 0 ? `（交易列 ${issue.sourceRowNumbers.join(', ')}）` : ''}
                </li>
              ))}</ul>
            </div>
          )}

          <details className="performance-official-details">
            <summary>正式帳戶 XIRR（等待真實入出金資料）</summary>
            <div className="metrics-grid">
              <Metric label="正式年化 XIRR" value={formatPercent(official.xirr)} hint="只使用 CASH_IN、CASH_OUT 與期末總資產" />
              <Metric label="正式外部現金流" value={official.externalCashFlows.length.toLocaleString()} hint="證券買賣不視為帳戶外部金流" />
            </div>
            <p className="empty-state">
              這個口徑保留供未來補齊銀行／證券帳戶真實入出金後使用。目前不會用推估證券 XIRR 冒充正式帳戶 XIRR。
            </p>
            {official.externalCashFlows.length > 0 && (
              <div className="table-wrap"><table>
                <thead><tr><th>日期</th><th>類型</th><th className="numeric">正式 XIRR 現金流（TWD）</th><th>來源</th></tr></thead>
                <tbody>{official.externalCashFlows.map((flow, index) => (
                  <tr key={`${flow.date}-${flow.kind}-${index}`}>
                    <td>{flow.date}</td><td>{OFFICIAL_KIND_LABEL[flow.kind]}</td>
                    <td className="numeric">{formatAmount(flow.signedAmountTwd)}</td>
                    <td>{flow.sourceRowNumbers.length > 0 ? `交易列 ${flow.sourceRowNumbers.join(', ')}` : 'ACTIVE 估值 Snapshot'}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </details>
        </>
      )}
    </section>
  )
}
