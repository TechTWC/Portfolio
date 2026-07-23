import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import FxCostStandalone from './FxCostStandalone'
import HistoricalNavStandalone from './HistoricalNavStandalone'
import PerformanceStandalone from './PerformanceStandalone'
import ValuationStandalone from './ValuationStandalone'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ValuationStandalone />
    <FxCostStandalone />
    <PerformanceStandalone />
    <HistoricalNavStandalone />
  </StrictMode>,
)
