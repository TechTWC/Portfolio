import { useEffect, useState } from 'react'
import FxCostWorkspace from './FxCostWorkspace'
import { subscribePortfolioDataUpdates } from './lib/data-sync'
import './fx-cost-standalone.css'

export default function FxCostStandalone() {
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => subscribePortfolioDataUpdates((update) => {
    if (update.kind === 'TRANSACTIONS_ACTIVATED') {
      setRefreshKey((current) => current + 1)
    }
  }), [])

  return (
    <>
      <a className="fx-cost-fixed-link" href="#fx-cost-basis">外幣 TWD 成本</a>
      <div className="fx-cost-standalone-shell">
        <FxCostWorkspace key={refreshKey} />
      </div>
    </>
  )
}
