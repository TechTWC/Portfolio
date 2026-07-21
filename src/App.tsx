import { useEffect, useMemo, useState } from 'react'
import { ApiError, api } from './lib/api'
import { readCachedBootstrap, writeCachedBootstrap } from './lib/cache'
import type { BootstrapResponse, DatasetDiff, DatasetUpload } from './lib/contracts'
import { compareTransactionSets } from './lib/diff'
import { PARSER_VERSION, parseTransactionFile, type ParseResult } from './lib/parser'

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(`${value.replace(' ', 'T')}Z`))
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
            <th className="numeric">股數</th><th className="numeric">價格</th><th className="numeric">原幣金額</th>
          </tr>
        </thead>
        <tbody>
          {data.transactions.slice(0, 100).map((row) => (
            <tr key={`${row.sourceRowNumber}-${row.rowHash}`}>
              <td>{row.tradeDate}</td><td>{row.transactionType}</td><td>{row.ticker || '—'}</td><td>{row.currency}</td>
              <td className="numeric">{row.quantity.toLocaleString()}</td>
              <td className="numeric">{row.price.toLocaleString()}</td>
              <td className="numeric">{row.amountForeign.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.transactions.length > 100 && <p className="table-note">僅顯示前 100 筆，共 {data.transactions.length.toLocaleString()} 筆。</p>}
    </div>
  )
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [diff, setDiff] = useState<DatasetDiff | null>(null)
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [message, setMessage] = useState<string>('')
  const [error, setError] = useState<string>('')

  function clearCandidate() {
    setParseResult(null)
    setPendingFile(null)
    setDiff(null)
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

  async function selectFile(file: File | null) {
    setError(''); setMessage(''); clearCandidate(); setPendingFile(file)
    if (!file || !bootstrap) return
    setBusy(true)
    try {
      const result = await parseTransactionFile(file)
      const payload: DatasetUpload = {
        baseRevision: bootstrap.cloudRevision,
        filename: file.name,
        fileHash: result.fileHash,
        parserVersion: PARSER_VERSION,
        sourceRowCount: result.sourceRowCount,
        rejectedRowCount: result.rejected.length,
        transactions: result.transactions,
      }
      const localDiff = compareTransactionSets(bootstrap.transactions, result.transactions)
      setParseResult(result)
      setDiff(localDiff)
      if (!offline) {
        const cloudPreview = await api.preview(payload)
        setDiff(cloudPreview.diff)
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
    if (!bootstrap || !parseResult || !pendingFile) return
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

  if (!bootstrap) {
    return <main className="loading"><div className="spinner" /><p>{error || '正在載入交易資料…'}</p></main>
  }

  const active = bootstrap.activeDataset
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>PA</span><div><strong>Portfolio Analyzer</strong><small>Cloud Ledger</small></div></div>
        <nav>
          <a className="active" href="#overview">投資組合總覽</a>
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

        <section className="panel" id="upload">
          <div className="panel-heading"><div><span>DATASET UPDATE</span><h2>上傳新版交易明細</h2><p>新檔案先解析、驗證及比較；確認後才會取代 ACTIVE 版本，舊版保留為 ARCHIVED。</p></div></div>
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
              <div className="diff-card"><span>拒收列</span><strong>{parseResult.rejected.length.toLocaleString()}</strong></div>
              <div className="preview-actions">
                <button className="secondary" onClick={clearCandidate} disabled={busy}>取消</button>
                <button className="primary" onClick={() => void activate()} disabled={busy || offline || diff.unchanged || parseResult.rejected.length > 0}>確認啟用新版</button>
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
              <ul>
                {parseResult.rejected.slice(0, 10).map((row) => (
                  <li key={row.sourceRowNumber}>第 {row.sourceRowNumber} 列：{row.reason}</li>
                ))}
              </ul>
              {parseResult.rejected.length > 10 && <small>另有 {parseResult.rejected.length - 10} 列未顯示。</small>}
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
