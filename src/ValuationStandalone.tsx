import { useEffect, useState } from 'react'
import ValuationWorkspace from './ValuationWorkspace'
import { subscribePortfolioDataUpdates } from './lib/data-sync'
import './valuation-standalone.css'

export default function ValuationStandalone() {
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => subscribePortfolioDataUpdates(() => {
    setRefreshKey((current) => current + 1)
  }), [])

  return (
    <>
      <a className="valuation-fixed-link" href="#valuation">估值與市值</a>
      <div className="valuation-standalone-shell">
        <ValuationWorkspace key={refreshKey} />
      </div>
    </>
  )
}
