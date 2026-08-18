import type { DrawdownSummary } from './time-weighted-performance'

export type DrawdownMetricPresentation = {
  currentDrawdownHint: string
  recoveryDateValue: string
  underwaterHint: string | undefined
}

export function drawdownMetricPresentation(
  complete: boolean,
  drawdown: DrawdownSummary,
): DrawdownMetricPresentation {
  if (!complete || drawdown.currentlyInDrawdown === null) {
    return {
      currentDrawdownHint: '回撤資料尚不能完整計算',
      recoveryDateValue: '—',
      underwaterHint: undefined,
    }
  }

  return {
    currentDrawdownHint: drawdown.currentlyInDrawdown
      ? `仍在回撤，已 ${drawdown.currentUnderwaterDays ?? 0} 天`
      : '目前已回到歷史高點',
    recoveryDateValue: drawdown.recoveryDate ?? '尚未修復',
    underwaterHint: drawdown.underwaterDays === null
      ? undefined
      : '自前高至修復；未修復則算到最新點',
  }
}
