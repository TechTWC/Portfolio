import { useEffect, useState } from 'react'
import PerformanceWorkspace from './PerformanceWorkspace'
import { subscribePortfolioDataUpdates } from './lib/data-sync'
import './performance-standalone.css'

export default function PerformanceStandalone() {
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => subscribePortfolioDataUpdates(() => {
    setRefreshKey((current) => current + 1)
  }), [])

  return (
    <>
      <a className="performance-fixed-link" href="#security-investment-summary">證券投入摘要</a>
      <div className="performance-standalone-shell">
        <PerformanceWorkspace key={refreshKey} />
      </div>
    </>
  )
}
