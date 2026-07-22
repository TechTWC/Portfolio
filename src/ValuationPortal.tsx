import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import ValuationWorkspace from './ValuationWorkspace'

export default function ValuationPortal() {
  const [contentTarget, setContentTarget] = useState<HTMLElement | null>(null)
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setContentTarget(document.querySelector<HTMLElement>('.content'))
    setNavTarget(document.querySelector<HTMLElement>('.sidebar nav'))
  }, [])

  return (
    <>
      {navTarget && createPortal(<a href="#valuation">估值與市值</a>, navTarget)}
      {contentTarget && createPortal(<ValuationWorkspace />, contentTarget)}
    </>
  )
}
