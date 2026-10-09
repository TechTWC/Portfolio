export type RequestGeneration = {
  begin: () => number
  invalidate: () => void
  isCurrent: (generation: number) => boolean
}

export function createRequestGeneration(): RequestGeneration {
  let current = 0
  return {
    begin() {
      current += 1
      return current
    },
    invalidate() {
      current += 1
    },
    isCurrent(generation) {
      return generation === current
    },
  }
}
