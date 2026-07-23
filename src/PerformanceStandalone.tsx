import PerformanceWorkspace from './PerformanceWorkspace'
import './performance-standalone.css'

export default function PerformanceStandalone() {
  return (
    <>
      <a className="performance-fixed-link" href="#performance-xirr">資金報酬與 XIRR</a>
      <div className="performance-standalone-shell">
        <PerformanceWorkspace />
      </div>
    </>
  )
}
