import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ValuationPortal from './ValuationPortal'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ValuationPortal />
  </StrictMode>,
)
