import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import ValuationWorkspace from './ValuationWorkspace'

export default function ValuationPortal() {
  const [contentTarget, setContentTarget] = useState<HTMLElement | null>(null)
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const content = document.querySelector<HTMLElement>('.content')
    const nav = document.querySelector<HTMLElement>('.sidebar nav')
    if (!content || !nav) return

    let valuationRoot = document.getElementById('valuation-panel-root')
    if (!valuationRoot) {
      valuationRoot = document.createElement('div')
      valuationRoot.id = 'valuation-panel-root'
      const transactionUpload = document.getElementById('upload')
      content.insertBefore(valuationRoot, transactionUpload)
    }

    let valuationNav = document.getElementById('valuation-nav-root')
    if (!valuationNav) {
      valuationNav = document.createElement('div')
      valuationNav.id = 'valuation-nav-root'
      const transactionUpdateLink = nav.querySelector<HTMLAnchorElement>('a[href="#upload"]')
      nav.insertBefore(valuationNav, transactionUpdateLink)
    }

    setContentTarget(valuationRoot)
    setNavTarget(valuationNav)

    return () => {
      setContentTarget(null)
      setNavTarget(null)
    }
  }, [])

  return (
    <>
      {navTarget && createPortal(<a href="#valuation">估值與市值</a>, navTarget)}
      {contentTarget && createPortal(<ValuationWorkspace />, contentTarget)}
    </>
  )
}
