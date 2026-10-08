import { describe, expect, it } from 'vitest'
import { createRequestGeneration } from '../src/lib/request-generation'

describe('strategy request generation', () => {
  it('rejects an older response after the form is edited', async () => {
    const guard = createRequestGeneration()
    const first = guard.begin()
    let rendered = 'none'

    const pending = Promise.resolve('old inputs').then((value) => {
      if (guard.isCurrent(first)) rendered = value
    })
    guard.invalidate()
    await pending

    expect(rendered).toBe('none')
  })

  it('accepts only the latest request when responses finish out of order', () => {
    const guard = createRequestGeneration()
    const first = guard.begin()
    const second = guard.begin()

    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })
})
