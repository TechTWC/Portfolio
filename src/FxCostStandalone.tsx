import FxCostWorkspace from './FxCostWorkspace'
import './fx-cost-standalone.css'

export default function FxCostStandalone() {
  return (
    <>
      <a className="fx-cost-fixed-link" href="#fx-cost-basis">外幣 TWD 成本</a>
      <div className="fx-cost-standalone-shell">
        <FxCostWorkspace />
      </div>
    </>
  )
}
