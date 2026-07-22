import { useEffect, useMemo, useState } from 'react'
import { api } from './lib/api'
import type { BootstrapResponse } from './lib/contracts'
import { buildFxCostPool } from './lib/fx-cost-pool'

function formatAmount(value: number): string {
  return value.toLocaleString('zh-TW', { maximumFractionDigits: 4 })
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

export default function FxCostWorkspace() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.bootstrap()
      .then(setBootstrap)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)))
  }, [])

  const result = useMemo(
    () => buildFxCostPool(bootstrap?.transactions ?? []),
    [bootstrap],
  )
  const openPositions = result.positions.filter((position) => Math.abs(position.quantity) > 1e-9)
  const foreignPositions = openPositions.filter((position) => position.currency !== 'TWD')

  return (
    <section className="panel" id="fx-cost-basis">
      <div className="panel-heading"><div>
        <span>FOREIGN CURRENCY COST POOL · v0.4</span>
        <h2>外幣成本池與股票 TWD 成本</h2>
        <p>採永續移動平均成本法。這裡記錄歷史 TWD 帳面成本，不使用目前估值匯率，也不是市場價值或投資報酬。</p>
      </div></div>

      {error && <div className="banner error">{error}</div>}
      {!bootstrap ? <div className="empty-state">正在載入外幣成本資料…</div> : (
        <>
          <div className="metrics-grid">
            <Metric label="成本方法" value="移動平均" hint="FIFO 尚未啟用" />
            <Metric label="外幣成本池" value={result.pools.length.toLocaleString()} />
            <Metric label="外幣持倉" value={foreignPositions.length.toLocaleString()} />
            <Metric
              label="成本阻擋錯誤"
              value={result.blockingIssueCount.toLocaleString()}
              hint={result.blockingIssueCount > 0 ? 'TWD 成本尚不能完整追溯' : 'TWD 成本序列可追溯'}
            />
          </div>

          <div className="panel-heading"><div>
            <span>FX COST POOL</span>
            <h2>各外幣剩餘數量與平均 TWD 成本</h2>
            <p>換入外幣會增加成本池；買股、換回台幣或出金會依動用前的移動平均匯率成本釋放 TWD 成本。</p>
          </div></div>
          {result.pools.length === 0 ? <div className="empty-state">目前沒有可計算的外幣成本池。</div> : (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>幣別</th>
                <th className="numeric">剩餘外幣</th>
                <th className="numeric">剩餘 TWD 成本</th>
                <th className="numeric">平均匯率成本</th>
                <th className="numeric">明確換匯流入</th>
                <th className="numeric">自動換匯流入</th>
                <th className="numeric">分攤至證券</th>
                <th className="numeric">直接換匯已實現損益</th>
              </tr></thead>
              <tbody>{result.pools.map((pool) => (
                <tr key={pool.currency}>
                  <td>{pool.currency}</td>
                  <td className="numeric">{formatAmount(pool.units)}</td>
                  <td className="numeric">{formatAmount(pool.twdCostBasis)}</td>
                  <td className="numeric">{formatAmount(pool.averageFxCost)}</td>
                  <td className="numeric">{formatAmount(pool.explicitFxUnitsIn)}</td>
                  <td className="numeric">{formatAmount(pool.automaticUnitsIn)}</td>
                  <td className="numeric">{formatAmount(pool.unitsAssignedToSecurities)}</td>
                  <td className="numeric">{formatAmount(pool.realizedFxPnlTwd)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}

          <div className="panel-heading"><div>
            <span>SECURITY TWD BASIS</span>
            <h2>各持倉原幣成本與 TWD 成本</h2>
            <p>原幣成本衡量股票本身；TWD 成本來自實際動用的外幣成本池。外幣股票賣出時，兩種成本都按持股比例釋放。</p>
          </div></div>
          {openPositions.length === 0 ? <div className="empty-state">目前沒有持倉成本資料。</div> : (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>標的</th><th>幣別</th>
                <th className="numeric">股數</th>
                <th className="numeric">原幣剩餘成本</th>
                <th className="numeric">TWD 剩餘成本</th>
                <th className="numeric">原幣平均／股</th>
                <th className="numeric">TWD 平均／股</th>
                <th className="numeric">TWD 已實現損益</th>
              </tr></thead>
              <tbody>{openPositions.map((position) => (
                <tr key={`${position.currency}-${position.ticker}`}>
                  <td>{position.ticker}</td><td>{position.currency}</td>
                  <td className="numeric">{formatAmount(position.quantity)}</td>
                  <td className="numeric">{formatAmount(position.nativeCostBasis)}</td>
                  <td className="numeric">{formatAmount(position.twdCostBasis)}</td>
                  <td className="numeric">{formatAmount(position.averageNativeUnitCost)}</td>
                  <td className="numeric">{formatAmount(position.averageTwdUnitCost)}</td>
                  <td className="numeric">{formatAmount(position.realizedPnlTwd)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}

          {result.issues.length > 0 && (
            <div className="rejected-list">
              <strong>外幣成本資料有阻擋型問題</strong>
              <ul>{result.issues.slice(0, 10).map((issue) => (
                <li key={`${issue.sourceRowNumber}-${issue.code}`}>
                  第 {issue.sourceRowNumber} 列 · {issue.code}：{issue.message}
                  {issue.required !== undefined && issue.available !== undefined
                    ? `（需要 ${formatAmount(issue.required)}，可用 ${formatAmount(issue.available)}）`
                    : ''}
                </li>
              ))}</ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
