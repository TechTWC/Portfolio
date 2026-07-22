import type {
  NormalizedValuationMark,
  ValuationSnapshotDiff,
} from './valuation-contracts'

const SAMPLE_LIMIT = 20

export function compareValuationMarks(
  oldMarks: NormalizedValuationMark[],
  newMarks: NormalizedValuationMark[],
): ValuationSnapshotDiff {
  const oldByHash = new Map(oldMarks.map((mark) => [mark.rowHash, mark]))
  const newByHash = new Map(newMarks.map((mark) => [mark.rowHash, mark]))

  const added = newMarks.filter((mark) => !oldByHash.has(mark.rowHash))
  const removed = oldMarks.filter((mark) => !newByHash.has(mark.rowHash))
  const unchangedMarks = newMarks.length - added.length

  return {
    unchanged: added.length === 0 && removed.length === 0,
    oldMarkCount: oldMarks.length,
    newMarkCount: newMarks.length,
    added: added.length,
    removed: removed.length,
    unchangedMarks,
    addedSamples: added.slice(0, SAMPLE_LIMIT),
    removedSamples: removed.slice(0, SAMPLE_LIMIT),
  }
}
