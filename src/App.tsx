import { useEffect, useMemo, useState } from 'react'
import { buildPortfolioAccounting, type PortfolioAccounting } from './lib/accounting'
import { ApiError, api } from './lib/api'
import { readCachedBootstrap, writeCachedBootstrap } from './lib/cache'
import { buildCashFundingLedger, type CashLedgerResult } from './lib/cash-ledger'
import type {
  BootstrapResponse,
  DatasetDiff,
  DatasetUpload,
  TransactionLineageSummary,
} from './lib/contracts'
import { validateDatasetForActivation, type DatasetActivationGate } from './lib/dataset-gate'
import { compareTransactionSets } from './lib/diff'
import { PARSER_VERSION, parseTransactionFile, type ParseResult } from './lib/parser'
import { planTransactionLineage } from './lib/transaction-lineage'

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(`${value.replace(' ', 'T')}Z`))
}

function formatAmount(value: number): string {
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

function DatasetTable({ data }: { data: BootstrapResponse }) {
  if (data.transactions.length === 0) return <div className="empty-state">目前沒有交易資料。</div>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>日期</th><th>類型</th><th>標的</th><th>幣別</th>
            <th className="numeric">股數</th><th className="numeric">價格</th><th className="numeric">原幣金額</th><th>交易 ID</th>
          </tr>
        </thead>
        <tbody>
          {data.transactions.slice(0, 100).map((row) => (
            <tr key={row.transactionId || row.rowHash}>
              <td>{row.tradeDate}</td><td>{row.transactionType}</td><td>{row.ticker || '—'}</td><td>{row.currency}</td>
              <td className="numeric">{row.quantity.toLocaleString()}</td>
              <td className="numeric">{row.price.toLocaleString()}</td>
              <td className="numeric">{row.amountForeign.toLocaleString()}</td>
              <td title={row.transactionId || row.rowHash}>{(row.transactionId || row.rowHash).slice(0, 8)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.transactions.length > 100 && <p className="table-note">僅顯示前 100 筆，共 {data.transactions.length.toLocaleString()} 筆。</p>}
    </div>
  )
}

function AccountingPanel({ accounting }: { accounting: PortfolioAccounting }) {
  const openPositions = accounting.positions.filter((position) => Math.abs(position.quantity) > 1e-9)
  return (
    <section className="panel" id="accounting">
      <div className="panel-heading"><div>
        <span>ACCOUNTING CORE · v0.1</span>
        <h2>交易帳務摘要</h2>
        <p>以移動平均成本法計算；各幣別分開呈現。尚未接入市場價格與匯率，因此這裡不是市值或投資報酬。</p>
      </div></div>

      <div className="metrics-grid">
        <Metric label="證券交易筆數" value={accounting.securityTransactionCount.toLocaleString()} />
        <Metric label="目前持有標的" value={openPositions.length.toLocaleString()} />
        <Metric label="帳務幣別" value={accounting.currencies.length.toLocaleString()} />
        <Metric label="阻擋型錯誤" value={accounting.blockingIssueCount.toLocaleString()} hint={accounting.blockingIssueCount > 0 ? '需修正交易資料' : '帳務序列可計算'} />
      </div>

      <div className="panel-heading"><div>
        <span>CURRENCY LEDGER</span><h2>各幣別證券現金流</h2>
        <p>不同幣別不得直接相加；淨現金流負數代表買進支出大於賣出收入。</p>
      </div></div>
      {accounting.currencies.length === 0 ? <div className="empty-state">目前沒有可計算的證券交易。</div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>幣別</th><th className="numeric">累計買入</th><th className="numeric">累計賣出</th><th className="numeric">費用</th><th className="numeric">淨證券現金流</th><th className="numeric">已實現損益</th></tr></thead>
          <tbody>{accounting.currencies.map((currency) => (
            <tr key={currency.currency}>
              <td>{currency.currency}</td>
              <td className="numeric">{formatAmount(currency.grossBuys)}</td>
              <td className="numeric">{formatAmount(currency.grossSells)}</td>
              <td className="numeric">{formatAmount(currency.fees)}</td>
              <td className="numeric">{formatAmount(currency.netSecurityCashFlow)}</td>
              <td className="numeric">{formatAmount(currency.realizedPnl)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      <div className="panel-heading"><div>
        <span>POSITION LEDGER</span><h2>持倉與移動平均成本</h2>
        <p>剩餘成本只保留尚未賣出的部位；已賣出成本會在成交當日釋放並計入已實現損益。</p>
      </div></div>
      {accounting.positions.length === 0 ? <div className="empty-state">目前沒有證券持倉紀錄。</div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>標的</th><th>幣別</th><th className="numeric">目前股數</th><th className="numeric">平均單位成本</th><th className="numeric">剩餘成本</th><th className="numeric">已實現損益</th></tr></thead>
          <tbody>{accounting.positions.map((position) => (
            <tr key={`${position.currency}-${position.ticker}`}>
              <td>{position.ticker}</td><td>{position.currency}</td>
              <td className="numeric">{formatAmount(position.quantity)}</td>
              <td className="numeric">{formatAmount(position.averageUnitCost)}</td>
              <td className="numeric">{formatAmount(position.costBasis)}</td>
              <td className="numeric">{formatAmount(position.realizedPnl)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      {accounting.issues.length > 0 && (
        <div className="rejected-list">
          <strong>帳務資料有阻擋型問題</strong>
          <ul>{accounting.issues.slice(0, 10).map((issue) => (
            <li key={`${issue.sourceRowNumber}-${issue.code}`}>第 {issue.sourceRowNumber} 列 · {issue.code}：{issue.message}</li>
          ))}</ul>
          {accounting.issues.length > 10 && <small>另有 {accounting.issues.length - 10} 項未顯示。</small>}
        </div>
      )}
    </section>
  )
}

function CashFundingPanel({ ledger }: { ledger: CashLedgerResult }) {
  return (
    <section className="panel" id="cash-funding">
      <div className="panel-heading"><div>
        <span>CASH & FX FUNDING · v0.2</span>
        <h2>現金與換匯資金核對</h2>
        <p>核對入金、出金、換匯及證券買賣是否有足夠現金。這裡尚未計算匯兌損益、市值或投資報酬。</p>
      </div></div>

      <div className="metrics-grid">
        <Metric label="追蹤模式" value={ledger.trackingMode} hint={ledger.trackingMode === 'UNTRACKED' ? '檔案沒有入金、出金或換匯列' : '已逐筆核對資金餘額'} />
        <Metric label="現金幣別" value={ledger.wallets.length.toLocaleString()} />
        <Metric label="資金阻擋錯誤" value={ledger.blockingIssueCount.toLocaleString()} hint={ledger.blockingIssueCount > 0 ? '不可忽略或截斷' : ledger.trackingMode === 'TRACKED' ? '現金序列可核對' : '尚未啟用嚴格核對'} />
        <Metric label="自動換匯" value={ledger.wallets.some((wallet) => wallet.autoFundedIn > 0 || wallet.autoFundingOut > 0) ? '有' : '無'} />
      </div>

      {ledger.trackingMode === 'UNTRACKED' ? (
        <div className="empty-state">目前 ACTIVE Dataset 只有證券交易，系統不假設起始現金，因此不會誤報資金不足。加入 CASH_IN、CASH_OUT、FX_BUY 或 FX_SELL 後，會自動切換為 TRACKED 嚴格核對。</div>
      ) : (
        <>
          <div className="panel-heading"><div>
            <span>NATIVE-CURRENCY WALLET</span><h2>各幣別現金帳</h2>
            <p>SECURITY／CASH 費用以該列幣別計；FX_BUY／FX_SELL 費用以 TWD 計。不同幣別不得直接相加。</p>
          </div></div>
          <div className="table-wrap"><table>
            <thead><tr>
              <th>幣別</th><th className="numeric">入金</th><th className="numeric">出金</th>
              <th className="numeric">換匯流入</th><th className="numeric">換匯流出</th>
              <th className="numeric">自動換匯流入</th><th className="numeric">自動換匯流出</th>
              <th className="numeric">證券支出</th><th className="numeric">證券收入</th>
              <th className="numeric">費用</th><th className="numeric">期末現金</th>
            </tr></thead>
            <tbody>{ledger.wallets.map((wallet) => (
              <tr key={wallet.currency}>
                <td>{wallet.currency}</td>
                <td className="numeric">{formatAmount(wallet.deposits)}</td>
                <td className="numeric">{formatAmount(wallet.withdrawals)}</td>
                <td className="numeric">{formatAmount(wallet.explicitFxIn)}</td>
                <td className="numeric">{formatAmount(wallet.explicitFxOut)}</td>
                <td className="numeric">{formatAmount(wallet.autoFundedIn)}</td>
                <td className="numeric">{formatAmount(wallet.autoFundingOut)}</td>
                <td className="numeric">{formatAmount(wallet.securitySpent)}</td>
                <td className="numeric">{formatAmount(wallet.securityReceived)}</td>
                <td className="numeric">{formatAmount(wallet.fees)}</td>
                <td className="numeric">{formatAmount(wallet.endingBalance)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </>
      )}

      {ledger.issues.length > 0 && (
        <div className="rejected-list">
          <strong>現金或換匯資料有阻擋型問題</strong>
          <ul>{ledger.issues.slice(0, 10).map((issue) => (
            <li key={`${issue.sourceRowNumber}-${issue.code}`}>
              第 {issue.sourceRowNumber} 列 · {issue.code}：{issue.message}
              {issue.required !== undefined && issue.available !== undefined
                ? `（需要 ${formatAmount(issue.required)}，可用 ${formatAmount(issue.available)}）`
                : ''}
            </li>
          ))}</ul>
          {ledger.issues.length > 10 && <small>另有 {ledger.issues.length - 10} 項未顯示。</small>}
        </div>
      )}
    </section>
  )
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [diff, setDiff] = useState<DatasetDiff | null>(null)
  const [candidateLineage, setCandidateLineage] = useState<TransactionLineageSummary | null>(null)
  const [candidateGate, setCandidateGate] = useState<DatasetActivationGate | null>(null)
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  function clearCandidate() {
    setParseResult(null)
    setPendingFile(null)
    setDiff(null)
    setCandidateLineage(null)
    setCandidateGate(null)
  }

  async function loadCloud(allowCacheFallback = true) {
    setError('')
    try {
      const cloud = await api.bootstrap()
      setBootstrap(cloud)
      setOffline(false)
      setMessage('')
      await writeCachedBootstrap(cloud)
    } catch (loadError) {
      const cached = allowCacheFallback ? await readCachedBootstrap() : null
      if (cached) {
        setBootstrap(cached)
        setOffline(true)
        setMessage(`目前使用 ${cached.user.email} 的本機快取；恢復連線後請重新同步雲端 ACTIVE 版本。`)
      } else {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    }
  }

  useEffect(() => { void loadCloud() }, [])

  const stats = useMemo(() => {
    const rows = bootstrap?.transactions ?? []
    const tickers = new Set(rows.filter((row) => row.transactionType === 'SECURITY').map((row) => row.ticker))
    return { rows: rows.length, tickers: tickers.size }
  }, [bootstrap])

  const accounting = useMemo(() => buildPortfolioAccounting(bootstrap?.transactions ?? []), [bootstrap])
  const cashLedger = useMemo(() => buildCashFundingLedger(bootstrap?.transactions ?? []), [bootstrap])

  async function selectFile(file: File | null) {
    setError(''); setMessage(''); clearCandidate(); setPendingFile(file)
    if (!file || !bootstrap) return
    setBusy(true)
    try {
      const result = await parseTransactionFile(file)
      const localGate = validateDatasetForActivation(result.transactions)
      const payload: DatasetUpload = {
        baseRevision: bootstrap.cloudRevision,
        filename: file.name,
        fileHash: result.fileHash,
        parserVersion: PARSER_VERSION,
        sourceRowCount: result.sourceRowCount,
        rejectedRowCount: result.rejected.length,
        transactions: result.transactions,
      }
      setParseResult(result)
      setDiff(compareTransactionSets(bootstrap.transactions, result.transactions))
      setCandidateLineage(planTransactionLineage(bootstrap.transactions, result.transactions).summary)
      setCandidateGate(localGate)

      if (!offline) {
        const cloudPreview = await api.preview(payload)
        setDiff(cloudPreview.diff)
        setCandidateLineage(cloudPreview.lineage)
        setCandidateGate(cloudPreview.activationGate)
        setMessage([...result.warnings, ...cloudPreview.warnings].join('；'))
      } else {
        setMessage('離線狀態只能預覽，恢復連線後才能啟用新版本。')
      }
    } catch (parseError) {
      if (parseError instanceof ApiError && parseError.code === 'VERSION_CONFLICT') {
        clearCandidate()
        setError('雲端資料已更新，候選版本已清除。請先按「重新同步」，再重新選擇檔案。')
      } else {
        setError(parseError instanceof Error ? parseError.message : String(parseError))
      }
    } finally {
      setBusy(false)
    }
  }

  async function activate() {
    if (!bootstrap || !parseResult || !pendingFile || (candidateGate?.blockingIssueCount ?? 0) > 0) return
    setBusy(true); setError(''); setMessage('')
    const payload: DatasetUpload = {
      baseRevision: bootstrap.cloudRevision,
      filename: pendingFile.name,
      fileHash: parseResult.fileHash,
      parserVersion: PARSER_VERSION,
      sourceRowCount: parseResult.sourceRowCount,
      rejectedRowCount: parseResult.rejected.length,
      transactions: parseResult.transactions,
    }
    try {
      const updated = await api.activate(payload)
      setBootstrap(updated)
      await writeCachedBootstrap(updated)
      clearCandidate(); setOffline(false)
      setMessage(`已啟用資料版本 v${updated.cloudRevision}，其他瀏覽器登入後會取得相同 ACTIVE 版本。`)
    } catch (activateError) {
      if (activateError instanceof ApiError && activateError.code === 'VERSION_CONFLICT') {
        await loadCloud(false)
        clearCandidate()
        setError('其他瀏覽器已更新雲端資料。系統已載入最新版，請重新選擇檔案比較。')
      } else {
        setError(activateError instanceof Error ? activateError.message : String(activateError))
      }
    } finally {
      setBusy(false)
    }
  }

  if (!bootstrap) return <main className="loading"><div className="spinner" /><p>{error || '正在載入交易資料…'}</p></main>

  const active = bootstrap.activeDataset
  const candidateBlockers = candidateGate?.blockingIssueCount ?? 0

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>PA</span><div><strong>Portfolio Analyzer</strong><small>Cloud Ledger</small></div></div>
        <nav>
          <a className="active" href="#overview">投資組合總覽</a>
          <a href="#accounting">交易帳務</a>
          <a href="#cash-funding">現金與換匯</a>
          <a href="#upload">交易資料更新</a>
          <a href="#transactions">交易明細</a>
          <a className="disabled" aria-disabled="true">策略比較 · 下一階段</a>
          <a className="disabled" aria-disabled="true">回撤分析 · 下一階段</a>
        </nav>
        <div className="identity"><small>登入帳號</small><strong>{bootstrap.user.email}</strong><span>{offline ? '離線快取' : '雲端已同步'}</span></div>
      </aside>

      <main className="content">
        <header className="page-header" id="overview">
          <div><span className="eyebrow">CLOUD-CANONICAL · LOCAL-CACHED</span><h1>投資組合資料中心</h1><p>交易明細以 D1 ACTIVE Dataset 為正式版本；每個瀏覽器保留 IndexedDB 快取。</p></div>
          <div className="header-actions"><span className={`status ${offline ? 'warning' : ''}`}>{offline ? 'Offline' : `Revision ${bootstrap.cloudRevision}`}</span><button className="secondary compact" onClick={() => void loadCloud(false)} disabled={busy}>重新同步</button></div>
        </header>

        {(message || error) && <div className={`banner ${error ? 'error' : ''}`}>{error || message}</div>}

        <section className="metrics-grid">
          <Metric label="有效交易筆數" value={stats.rows.toLocaleString()} hint={active?.filename ?? '尚未上傳'} />
          <Metric label="證券標的數" value={stats.tickers.toLocaleString()} />
          <Metric label="雲端版本" value={`v${bootstrap.cloudRevision}`} hint={active ? formatDateTime(active.activatedAt) : '尚未啟用'} />
          <Metric label="交易期間" value={active ? `${active.earliestDate} → ${active.latestDate}` : '—'} />
        </section>

        <AccountingPanel accounting={accounting} />
        <CashFundingPanel ledger={cashLedger} />

        <section className="panel" id="upload">
          <div className="panel-heading"><div><span>DATASET UPDATE</span><h2>上傳新版交易明細</h2><p>新檔案先解析、驗證、帳務與資金核對；全部通過後才可取代 ACTIVE 版本。</p></div></div>
          <label className={`upload-zone ${busy ? 'busy' : ''}`}>
            <input type="file" accept=".xlsx,.xls,.csv" disabled={busy} onChange={(event) => void selectFile(event.target.files?.[0] ?? null)} />
            <strong>{busy ? '正在驗證…' : '選擇 Excel 或 CSV'}</strong>
            <span>不會在驗證前覆蓋目前資料</span>
          </label>

          {parseResult && diff && (
            <div className="preview-grid">
              <div className="diff-card"><span>目前筆數</span><strong>{diff.oldRowCount.toLocaleString()}</strong></div>
              <div className="diff-card"><span>新版筆數</span><strong>{diff.newRowCount.toLocaleString()}</strong></div>
              <div className="diff-card positive"><span>新增</span><strong>+{diff.added.toLocaleString()}</strong></div>
              <div className="diff-card negative"><span>刪除／變更</span><strong>-{diff.removed.toLocaleString()}</strong></div>
              <div className="diff-card positive"><span>保留交易 ID</span><strong>{candidateLineage?.unchanged.toLocaleString() ?? '—'}</strong></div>
              <div className="diff-card"><span>更正追蹤</span><strong>{candidateLineage?.corrected.toLocaleString() ?? '—'}</strong></div>
              <div className={`diff-card ${(candidateLineage?.ambiguous ?? 0) > 0 ? 'negative' : 'positive'}`}><span>血緣不確定</span><strong>{candidateLineage?.ambiguous.toLocaleString() ?? '—'}</strong></div>
              <div className="diff-card"><span>拒收列</span><strong>{parseResult.rejected.length.toLocaleString()}</strong></div>
              <div className={`diff-card ${candidateBlockers > 0 ? 'negative' : 'positive'}`}><span>帳務／資金阻擋</span><strong>{candidateBlockers.toLocaleString()}</strong></div>
              <div className="preview-actions">
                <button className="secondary" onClick={clearCandidate} disabled={busy}>取消</button>
                <button className="primary" onClick={() => void activate()} disabled={busy || offline || diff.unchanged || parseResult.rejected.length > 0 || candidateBlockers > 0}>確認啟用新版</button>
              </div>
            </div>
          )}

          {diff && (diff.addedSamples.length > 0 || diff.removedSamples.length > 0) && (
            <div className="change-samples">
              {diff.addedSamples.length > 0 && <div><strong>新增交易範例</strong><ul>{diff.addedSamples.map((row) => <li key={`add-${row.rowHash}`}>{row.tradeDate} · {row.transactionType} · {row.ticker || row.currency} · {row.quantity || row.amountForeign}</li>)}</ul></div>}
              {diff.removedSamples.length > 0 && <div><strong>刪除／變更交易範例</strong><ul>{diff.removedSamples.map((row) => <li key={`remove-${row.rowHash}`}>{row.tradeDate} · {row.transactionType} · {row.ticker || row.currency} · {row.quantity || row.amountForeign}</li>)}</ul></div>}
              <small>最多顯示各 20 筆；實際筆數以上方統計為準。</small>
            </div>
          )}

          {parseResult && parseResult.rejected.length > 0 && (
            <div className="rejected-list">
              <strong>新版尚不能啟用：請修正所有拒收列</strong>
              <ul>{parseResult.rejected.slice(0, 10).map((row) => <li key={row.sourceRowNumber}>第 {row.sourceRowNumber} 列：{row.reason}</li>)}</ul>
              {parseResult.rejected.length > 10 && <small>另有 {parseResult.rejected.length - 10} 列未顯示。</small>}
            </div>
          )}

          {candidateGate && candidateGate.issues.length > 0 && (
            <div className="rejected-list">
              <strong>新版尚不能啟用：帳務或資金序列有阻擋型錯誤</strong>
              <ul>{candidateGate.issues.slice(0, 10).map((issue) => (
                <li key={`${issue.domain}-${issue.sourceRowNumber}-${issue.code}`}>
                  第 {issue.sourceRowNumber} 列 · {issue.code}：{issue.message}
                  {issue.required !== undefined && issue.available !== undefined
                    ? `（需要 ${formatAmount(issue.required)}，可用 ${formatAmount(issue.available)}）`
                    : ''}
                </li>
              ))}</ul>
              {candidateGate.issues.length > 10 && <small>另有 {candidateGate.issues.length - 10} 項未顯示。</small>}
            </div>
          )}
        </section>

        <section className="panel" id="transactions">
          <div className="panel-heading"><div><span>ACTIVE DATASET</span><h2>目前有效交易明細</h2><p>{active ? `${active.filename} · Parser ${active.parserVersion}` : '尚未建立 ACTIVE Dataset'}</p></div></div>
          <DatasetTable data={bootstrap} />
        </section>
      </main>
    </div>
  )
}
