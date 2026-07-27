import { useEffect, useState } from 'react'
import HistoricalNavWorkspace from './HistoricalNavWorkspace'
import { subscribePortfolioDataUpdates } from './lib/data-sync'
import './historical-nav-standalone.css'

export default function HistoricalNavStandalone() {
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => subscribePortfolioDataUpdates(() => {
    setRefreshKey((current) => current + 1)
  }), [])

  return (
    <>
      <a className="historical-nav-fixed-link" href="#historical-nav">歷史 NAV</a>
      <div className="historical-nav-standalone-shell">
        <HistoricalNavWorkspace key={refreshKey} />
      </div>
    </>
  )
}
