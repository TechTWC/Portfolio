import HistoricalNavWorkspace from './HistoricalNavWorkspace'
import './historical-nav-standalone.css'

export default function HistoricalNavStandalone() {
  return (
    <>
      <a className="historical-nav-fixed-link" href="#historical-nav">歷史 NAV</a>
      <div className="historical-nav-standalone-shell">
        <HistoricalNavWorkspace />
      </div>
    </>
  )
}
