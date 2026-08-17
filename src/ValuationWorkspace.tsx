import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api } from './lib/api'
import { buildFxCostPool } from './lib/fx-cost-pool'
import type { MarketDataBootstrapResponse } from './lib/market-data-contracts'
import type {
  ValuationBootstrapResponse,
  ValuationPreviewResponse,
  ValuationSnapshotUpload,
} from './lib/valuation-contracts'
import { reconcileValuationWithTwdCost } from './lib/valuation-cost-reconciliation'
import {
  parseValuationFile,
  VALUATION_PARSER_VERSION,
  type ValuationParseResult,
} from './lib/valuation-parser'

function formatAmount(value: number | null): string {
  if (value === null) return '—'
  return value.toLocaleString('zh-TW', { maximumFractionDigits: 2 })
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(`${value.replace(' ', 'T')}Z`))
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

function positionKey(ticker: string, currency: string): string {
  return `${ticker.toUpperCase()}\u0000${currency.toUpperCase()}`
}

export default function ValuationWorkspace() {
  const [bootstrap, setBootstrap] = useState<ValuationBootstrapResponse | null>(null)
  const [marketData, setMarketData] = useState<MarketDataBootstrapResponse | null>(null)
  const [parseResult, setParseResult] = useState<ValuationParseResult | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ValuationPreviewResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  function clearCandidate() {
    setParseResult(null)
    setPendingFile(null)
    setPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function loadValuation() {
    setError('')
    try {
      const [valuation, market] = await Promise.all([
        api.valuationBootstrap(),
        api.marketDataBootstrap(false),
      ])
      setBootstrap(valuation)
      setMarketData(market)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    }
  }

  useEffect(() => { void loadValuation() }, [])

  async function refreshAutomaticMarketData() {
    if (!bootstrap?.currentTransactionDatasetId) return
    setBusy(true); setError(''); setMessage(''); clearCandidate()
    try {
      const updated = await api.marketDataRefresh({
        baseValuationRevision: bootstrap.valuationRevision,
        transactionDatasetId: bootstrap.currentTransactionDatasetId,
        transactionRevision: bootstrap.currentTransactionRevision,
      })
      setBootstrap(updated.valuation)
      setMarketData(updated.market)
      setMessage(
        `行情更新完成：${updated.market.activeRun?.instrumentCount ?? 0} 個標的、`
        + `${updated.market.activeRun?.barCount.toLocaleString() ?? 0} 筆本次行情；`
        + `估值已更新至 v${updated.valuation.valuationRevision}。`,
      )
    } catch (refreshError) {
      if (refreshError instanceof ApiError && [
        'VALUATION_VERSION_CONFLICT',
        'TRANSACTION_VERSION_CONFLICT',
        'MARKET_DATA_VERSION_CONFLICT',
      ].includes(refreshError.code ?? '')) {
        await loadValuation()
        setError('其他分頁已更新交易、行情或估值版本。系統已重新載入，請再按一次更新。')
      } else {
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
      }
    } finally {
      setBusy(false)
    }
  }

  async function selectValuationFile(file: File | null) {
    setError(''); setMessage(''); clearCandidate(); setPendingFile(file)
    if (!file || !bootstrap) return
    setBusy(true)
    try {
      const result = await parseValuationFile(file)
      if (!bootstrap.currentTransactionDatasetId) {
        throw new Error('目前沒有 ACTIVE 交易資料，不能建立估值')
      }
      const payload: ValuationSnapshotUpload = {
        baseRevision: bootstrap.valuationRevision,
        transactionDatasetId: bootstrap.currentTransactionDatasetId,
        transactionRevision: bootstrap.currentTransactionRevision,
        valuationDate: result.valuationDate,
        filename: file.name,
        fileHash: result.fileHash,
        parserVersion: VALUATION_PARSER_VERSION,
        sourceRowCount: result.sourceRowCount,
        rejectedRowCount: result.rejected.length,
        marks: result.marks,
      }
      const cloudPreview = await api.valuationPreview(payload)
      setParseResult(result)
      setPreview(cloudPreview)
      setMessage([...result.warnings, ...cloudPreview.warnings].join('；'))
    } catch (previewError) {
      if (previewError instanceof ApiError && ['VALUATION_VERSION_CONFLICT', 'TRANSACTION_VERSION_CONFLICT'].includes(previewError.code ?? '')) {
        await loadValuation()
        clearCandidate()
        setError('雲端交易或估值版本已更新，候選資料已清除。請重新選擇估值檔。')
      } else {
        setError(previewError instanceof Error ? previewError.message : String(previewError))
      }
    } finally {
      setBusy(false)
    }
  }

  async function activateValuation() {
    if (!bootstrap || !bootstrap.currentTransactionDatasetId || !parseResult || !pendingFile || !preview?.activationAllowed) return
    setBusy(true); setError(''); setMessage('')
    const payload: ValuationSnapshotUpload = {
      baseRevision: bootstrap.valuationRevision,
      transactionDatasetId: bootstrap.currentTransactionDatasetId,
      transactionRevision: bootstrap.currentTransactionRevision,
      valuationDate: parseResult.valuationDate,
      filename: pendingFile.name,
      fileHash: parseResult.fileHash,
      parserVersion: VALUATION_PARSER_VERSION,
      sourceRowCount: parseResult.sourceRowCount,
      rejectedRowCount: parseResult.rejected.length,
      marks: parseResult.marks,
    }
    try {
      const updated = await api.valuationActivate(payload)
      setBootstrap(updated)
      clearCandidate()
      setMessage(`已啟用估值版本 v${updated.valuationRevision}，綁定交易 v${updated.activeSnapshot?.transactionRevision ?? '—'}，估值日為 ${updated.activeSnapshot?.valuationDate ?? '—'}。`)
    } catch (activateError) {
      if (activateError instanceof ApiError && ['VALUATION_VERSION_CONFLICT', 'TRANSACTION_VERSION_CONFLICT'].includes(activateError.code ?? '')) {
        await loadValuation()
        clearCandidate()
        setError('其他瀏覽器已更新交易或估值資料。系統已載入最新版，請重新選擇檔案。')
      } else {
        setError(activateError instanceof Error ? activateError.message : String(activateError))
      }
    } finally {
      setBusy(false)
    }
  }

  const active = bootstrap?.activeSnapshot ?? null
  const valuation = bootstrap?.valuation ?? null
  const candidate = preview?.valuation ?? null
  const fxCost = useMemo(
    () => buildFxCostPool(bootstrap?.transactions ?? []),
    [bootstrap],
  )
  const reconciliation = useMemo(
    () => valuation ? reconcileValuationWithTwdCost(valuation, fxCost) : null,
    [valuation, fxCost],
  )
  const reconciliationByPosition = useMemo(
    () => new Map(
      (reconciliation?.positions ?? []).map((position) => [
        positionKey(position.ticker, position.currency),
        position,
      ]),
    ),
    [reconciliation],
  )

  return (
    <>
      <section className="panel" id="valuation">
        <div className="panel-heading"><div>
          <span>POINT-IN-TIME VALUATION · v0.3 + TWD BASIS v0.4</span>
          <h2>估值 Snapshot</h2>
          <p>市值只使用估值日當天或更早的價格與匯率；TWD 成本來自歷史外幣移動平均成本池。尚未計算報酬率或拆分價格與匯率貢獻。</p>
        </div></div>

        {(message || error) && <div className={`banner ${error ? 'error' : ''}`}>{error || message}</div>}
        {bootstrap?.freshness === 'STALE' && (
          <div className="banner error">
            此估值綁定交易 v{active?.transactionRevision ?? '—'}，目前交易已是 v{bootstrap.currentTransactionRevision}。數字仍以原交易版本重現，請重新啟用估值後再作投資決策。
          </div>
        )}

        {!bootstrap ? <div className="empty-state">正在載入估值資料…</div> : (
          <>
            <div className="market-refresh-card">
              <div>
                <span>AUTOMATIC MARKET DATA · v1</span>
                <h2>一鍵取得最新收盤價</h2>
                <p>
                  抓取所有曾持有證券、必要匯率與 SPY 基準的 raw close；完整驗證後才更新估值。
                  首次會回補歷史日資料，後續只重抓最近區間。這是收盤資料，不是即時報價。
                </p>
              </div>
              <button
                className="primary"
                onClick={() => void refreshAutomaticMarketData()}
                disabled={busy || !bootstrap.currentTransactionDatasetId}
              >
                {busy ? '正在取得並驗證行情…' : '更新最新收盤價'}
              </button>
            </div>

            {marketData?.activeRun && (
              <div className="market-data-summary">
                <span>
                  行情 v{marketData.marketRevision}｜{marketData.activeRun.provider}｜
                  {marketData.activeRun.earliestBarDate ?? '—'} → {marketData.activeRun.latestBarDate ?? '—'}｜
                  綁定交易 v{marketData.activeRun.transactionRevision}｜
                  {marketData.freshness === 'CURRENT' ? 'CURRENT' : 'STALE'}
                </span>
                <div className="table-wrap"><table>
                  <thead><tr>
                    <th>用途</th><th>標的／匯率</th><th>幣別</th><th>來源代號</th>
                    <th>最新日期</th><th className="numeric">最新 raw close</th><th className="numeric">本次筆數</th>
                  </tr></thead>
                  <tbody>{marketData.instruments.map((instrument) => (
                    <tr key={`${instrument.instrumentType}-${instrument.ticker}-${instrument.currency}`}>
                      <td>{instrument.instrumentType}</td>
                      <td>{instrument.instrumentType === 'FX' ? `${instrument.currency}/TWD` : instrument.ticker}</td>
                      <td>{instrument.currency}</td>
                      <td>{instrument.providerSymbol}</td>
                      <td>{instrument.latestBarDate}</td>
                      <td className="numeric">{formatAmount(instrument.latestRawClose)}</td>
                      <td className="numeric">{instrument.barCount.toLocaleString()}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </div>
            )}

            <div className="metrics-grid">
              <Metric label="估值版本" value={`v${bootstrap.valuationRevision}`} hint={active ? formatDateTime(active.activatedAt) : '尚未建立'} />
              <Metric label="交易血緣" value={active ? `v${active.transactionRevision}` : '—'} hint={active?.transactionDatasetId ?? '尚未綁定'} />
              <Metric label="估值日" value={active?.valuationDate ?? '—'} hint={active?.filename ?? '尚未上傳'} />
              <Metric label="估值狀態" value={bootstrap.freshness === 'STALE' ? 'STALE' : valuation ? (valuation.complete ? 'CURRENT' : '不完整') : '尚未估值'} hint={bootstrap.freshness === 'STALE' ? `目前交易為 v${bootstrap.currentTransactionRevision}` : valuation && !valuation.complete ? `${valuation.blockingIssueCount} 項阻擋問題` : undefined} />
              <Metric label="TWD 總資產" value={valuation?.totalAssetsTwd === null || valuation?.totalAssetsTwd === undefined ? '—' : formatAmount(valuation.totalAssetsTwd)} hint="市值 Snapshot，不是投資報酬" />
            </div>

            {valuation && (
              <div className="metrics-grid">
                <Metric label="持倉 TWD 成本" value={formatAmount(reconciliation?.totalPositionTwdCostBasis ?? null)} hint="歷史移動平均帳面成本" />
                <Metric label="TWD 未實現損益" value={formatAmount(reconciliation?.totalUnrealizedPnlTwd ?? null)} hint="持倉市值減持倉 TWD 成本" />
                <Metric label="TWD 已實現損益" value={formatAmount(reconciliation?.totalRealizedPnlTwd ?? null)} hint="證券與直接換匯已實現損益" />
                <Metric label="成本對帳" value={reconciliation?.complete ? '完整' : '不完整'} hint={!reconciliation?.complete ? `${reconciliation?.missingCostKeys.length ?? 0} 檔缺成本／${reconciliation?.costBlockingIssueCount ?? 0} 項成本錯誤` : '估值持倉與 TWD 成本逐檔一致'} />
              </div>
            )}

            {!valuation ? <div className="empty-state">目前沒有 ACTIVE 估值 Snapshot。請在下方上傳價格與匯率測試檔。</div> : (
              <>
                <div className="panel-heading"><div>
                  <span>POSITION VALUATION</span><h2>持倉市值、原幣損益與 TWD 損益</h2>
                  <p>原幣損益衡量股票本身；TWD 未實現損益直接比較目前 TWD 市值與歷史 TWD 成本，包含價格及匯率變動的合計效果。</p>
                </div></div>
                <div className="table-wrap"><table>
                  <thead><tr>
                    <th>標的</th><th>幣別</th><th className="numeric">股數</th><th className="numeric">原幣剩餘成本</th>
                    <th className="numeric">價格</th><th>價格日期</th><th className="numeric">原幣市值</th>
                    <th className="numeric">原幣未實現損益</th><th className="numeric">匯率</th><th className="numeric">TWD 市值</th>
                    <th className="numeric">TWD 成本</th><th className="numeric">TWD 未實現損益</th>
                  </tr></thead>
                  <tbody>{valuation.positions.map((position) => {
                    const twd = reconciliationByPosition.get(positionKey(position.ticker, position.currency))
                    return (
                      <tr key={`${position.currency}-${position.ticker}`}>
                        <td>{position.ticker}</td><td>{position.currency}</td>
                        <td className="numeric">{formatAmount(position.quantity)}</td>
                        <td className="numeric">{formatAmount(position.costBasis)}</td>
                        <td className="numeric">{formatAmount(position.price)}</td>
                        <td>{position.priceDate ?? '—'}</td>
                        <td className="numeric">{formatAmount(position.marketValueNative)}</td>
                        <td className="numeric">{formatAmount(position.unrealizedPnlNative)}</td>
                        <td className="numeric">{formatAmount(position.fxRate)}</td>
                        <td className="numeric">{formatAmount(position.marketValueTwd)}</td>
                        <td className="numeric">{formatAmount(twd?.twdCostBasis ?? null)}</td>
                        <td className="numeric">{formatAmount(twd?.unrealizedPnlTwd ?? null)}</td>
                      </tr>
                    )
                  })}</tbody>
                </table></div>

                <div className="panel-heading"><div>
                  <span>CASH VALUATION</span><h2>現金換算</h2>
                  <p>各幣別期末現金依估值日最新可用匯率換算；TWD 匯率固定為 1。</p>
                </div></div>
                <div className="table-wrap"><table>
                  <thead><tr><th>幣別</th><th className="numeric">原幣現金</th><th className="numeric">匯率</th><th>匯率日期</th><th className="numeric">TWD 價值</th></tr></thead>
                  <tbody>{valuation.cash.map((cash) => (
                    <tr key={cash.currency}>
                      <td>{cash.currency}</td>
                      <td className="numeric">{formatAmount(cash.endingBalance)}</td>
                      <td className="numeric">{formatAmount(cash.fxRate)}</td>
                      <td>{cash.fxDate ?? '—'}</td>
                      <td className="numeric">{formatAmount(cash.marketValueTwd)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>

                {valuation.issues.length > 0 && (
                  <div className="rejected-list">
                    <strong>ACTIVE 估值有阻擋問題</strong>
                    <ul>{valuation.issues.slice(0, 10).map((issue, index) => (
                      <li key={`${issue.code}-${index}`}>{issue.code}：{issue.message}</li>
                    ))}</ul>
                  </div>
                )}

                {reconciliation && !reconciliation.complete && (
                  <div className="rejected-list">
                    <strong>TWD 成本對帳尚未完整</strong>
                    <ul>
                      {reconciliation.missingCostKeys.map((missing) => <li key={missing}>缺少成本：{missing}</li>)}
                      {reconciliation.costBlockingIssueCount > 0 && <li>外幣成本池有 {reconciliation.costBlockingIssueCount} 項阻擋錯誤。</li>}
                    </ul>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>

      <section className="panel" id="valuation-upload">
        <div className="panel-heading"><div>
          <span>VALUATION SNAPSHOT UPDATE</span>
          <h2>上傳價格與匯率</h2>
          <p>估值檔會先解析、比較並以目前 ACTIVE 交易資料試算；完整且無衝突時才能啟用。</p>
        </div></div>

        <label className={`upload-zone ${busy ? 'busy' : ''}`}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={busy || !bootstrap?.currentTransactionDatasetId}
            onClick={(event) => { event.currentTarget.value = '' }}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] ?? null
              event.currentTarget.value = ''
              void selectValuationFile(file)
            }}
          />
          <strong>{busy ? '正在驗證估值…' : '選擇估值 Excel 或 CSV'}</strong>
          <span>欄位：估值日、標記日期、類型、股票代號、幣別、數值、來源</span>
        </label>

        {parseResult && preview && (
          <>
            <div className="preview-grid">
              <div className="diff-card"><span>目前標記</span><strong>{preview.diff.oldMarkCount.toLocaleString()}</strong></div>
              <div className="diff-card"><span>新版標記</span><strong>{preview.diff.newMarkCount.toLocaleString()}</strong></div>
              <div className="diff-card positive"><span>新增</span><strong>+{preview.diff.added.toLocaleString()}</strong></div>
              <div className="diff-card negative"><span>刪除／變更</span><strong>-{preview.diff.removed.toLocaleString()}</strong></div>
              <div className="diff-card"><span>拒收列</span><strong>{parseResult.rejected.length.toLocaleString()}</strong></div>
              <div className={`diff-card ${candidate?.blockingIssueCount ? 'negative' : 'positive'}`}><span>估值阻擋</span><strong>{candidate?.blockingIssueCount.toLocaleString() ?? '—'}</strong></div>
              <div className="diff-card"><span>未來標記忽略</span><strong>{candidate?.futureMarkCount.toLocaleString() ?? '—'}</strong></div>
              <div className={`diff-card ${preview.activationAllowed ? 'positive' : 'negative'}`}><span>候選總資產</span><strong>{candidate?.totalAssetsTwd === null || candidate?.totalAssetsTwd === undefined ? '不完整' : formatAmount(candidate.totalAssetsTwd)}</strong></div>
              <div className="preview-actions">
                <button className="secondary" onClick={clearCandidate} disabled={busy}>取消</button>
                <button className="primary" onClick={() => void activateValuation()} disabled={busy || (preview.diff.unchanged && bootstrap?.freshness !== 'STALE') || !preview.activationAllowed}>確認啟用估值</button>
              </div>
            </div>

            {parseResult.rejected.length > 0 && (
              <div className="rejected-list">
                <strong>估值檔尚不能啟用：請修正拒收列</strong>
                <ul>{parseResult.rejected.slice(0, 10).map((row) => <li key={row.sourceRowNumber}>第 {row.sourceRowNumber} 列：{row.reason}</li>)}</ul>
              </div>
            )}

            {candidate && candidate.issues.length > 0 && (
              <div className="rejected-list">
                <strong>估值 Snapshot 尚不能啟用</strong>
                <ul>{candidate.issues.slice(0, 10).map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>{issue.code}：{issue.message}</li>
                ))}</ul>
              </div>
            )}
          </>
        )}
      </section>
    </>
  )
}
