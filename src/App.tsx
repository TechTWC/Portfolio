import { useEffect, useState } from 'react'

type Tx = { tradeDate: string; transactionType: string; ticker: string; currency: string; quantity: number; price: number; amountForeign: number }
type Bootstrap = { revision: number; dataset: null | { id: string; filename: string; rowCount: number; transactions: Tx[] } }

const splitCsv = (text: string): Tx[] => {
  const [head, ...rows] = text.trim().split(/\r?\n/)
  if (!head) return []
  const headers = head.split(',').map((x) => x.trim())
  const col = (row: string[], name: string) => row[headers.indexOf(name)]?.trim() ?? ''
  return rows.filter(Boolean).map((line) => {
    const row = line.split(',')
    const type = col(row, '交易類型') || 'SECURITY'
    return {
      tradeDate: col(row, '日期'),
      transactionType: type === 'BUY' || type === 'SELL' ? 'SECURITY' : type,
      ticker: col(row, '股票代號'),
      currency: col(row, '幣別') || 'TWD',
      quantity: Number(col(row, '購買股數') || 0) * (type === 'SELL' ? -1 : 1),
      price: Number(col(row, '購買股價') || 0),
      amountForeign: Number(col(row, '原幣金額') || 0),
    }
  })
}

export default function App() {
  const [data, setData] = useState<Bootstrap>({ revision: 0, dataset: null })
  const [message, setMessage] = useState('讀取雲端資料中…')

  const reload = async () => {
    const response = await fetch('/api/bootstrap')
    if (!response.ok) throw new Error(await response.text())
    const next = await response.json() as Bootstrap
    setData(next)
    setMessage(next.dataset ? '已載入雲端 ACTIVE 版本' : '尚未上傳交易明細')
  }

  useEffect(() => { reload().catch((error) => setMessage(String(error))) }, [])

  const upload = async (file: File) => {
    setMessage('解析與上傳中…')
    const transactions = splitCsv(await file.text())
    if (!transactions.length) throw new Error('沒有可匯入的交易資料')
    const response = await fetch('/api/datasets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, baseRevision: data.revision, transactions }),
    })
    if (!response.ok) throw new Error(await response.text())
    await reload()
  }

  return <main>
    <header><div><p className="eyebrow">Cloud-canonical · Local-cached</p><h1>Portfolio Analyzer</h1></div><span className="badge">Revision {data.revision}</span></header>
    <section className="card hero"><div><h2>跨瀏覽器交易資料</h2><p>{message}</p></div><label className="upload">上傳新版 CSV<input type="file" accept=".csv" onChange={(e) => { const file = e.target.files?.[0]; if (file) upload(file).catch((error) => setMessage(String(error))) }}/></label></section>
    <section className="metrics"><article><span>目前檔案</span><strong>{data.dataset?.filename ?? '—'}</strong></article><article><span>交易筆數</span><strong>{data.dataset?.rowCount ?? 0}</strong></article><article><span>同步狀態</span><strong>{data.dataset ? 'ACTIVE' : 'EMPTY'}</strong></article></section>
    <section className="card"><h2>交易明細</h2><div className="table-wrap"><table><thead><tr><th>日期</th><th>類型</th><th>標的</th><th>幣別</th><th>數量</th><th>價格</th></tr></thead><tbody>{data.dataset?.transactions.map((tx, index) => <tr key={`${tx.tradeDate}-${index}`}><td>{tx.tradeDate}</td><td>{tx.transactionType}</td><td>{tx.ticker || '—'}</td><td>{tx.currency}</td><td>{tx.quantity}</td><td>{tx.price}</td></tr>)}</tbody></table></div></section>
  </main>
}
