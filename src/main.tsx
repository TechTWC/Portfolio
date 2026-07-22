import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ValuationStandalone from './ValuationStandalone'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ValuationStandalone />
  </StrictMode>,
)
