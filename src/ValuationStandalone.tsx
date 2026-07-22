import ValuationWorkspace from './ValuationWorkspace'
import './valuation-standalone.css'

export default function ValuationStandalone() {
  return (
    <>
      <a className="valuation-fixed-link" href="#valuation">估值與市值</a>
      <div className="valuation-standalone-shell">
        <ValuationWorkspace />
      </div>
    </>
  )
}
