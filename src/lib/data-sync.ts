export type PortfolioDataUpdateKind = 'TRANSACTIONS_ACTIVATED' | 'VALUATION_ACTIVATED'

export type PortfolioDataUpdate = {
  id: string
  kind: PortfolioDataUpdateKind
  occurredAt: string
  transactionRevision?: number
  valuationRevision?: number
}

const DOM_EVENT_NAME = 'portfolio-analyzer:data-updated'
const BROADCAST_CHANNEL_NAME = 'portfolio-analyzer-data-updated'

function browserEventTarget(): EventTarget | null {
  return 'document' in globalThis ? globalThis : null
}

function createEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function publishPortfolioDataUpdate(
  detail: Omit<PortfolioDataUpdate, 'id' | 'occurredAt'>,
): PortfolioDataUpdate {
  const message: PortfolioDataUpdate = {
    ...detail,
    id: createEventId(),
    occurredAt: new Date().toISOString(),
  }

  browserEventTarget()?.dispatchEvent(new CustomEvent<PortfolioDataUpdate>(DOM_EVENT_NAME, { detail: message }))

  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
    channel.postMessage(message)
    channel.close()
  }

  return message
}

export function subscribePortfolioDataUpdates(
  listener: (update: PortfolioDataUpdate) => void,
): () => void {
  const seenIds = new Set<string>()

  function deliver(update: PortfolioDataUpdate) {
    if (!update?.id || seenIds.has(update.id)) return
    seenIds.add(update.id)
    if (seenIds.size > 100) {
      const oldest = seenIds.values().next().value
      if (oldest) seenIds.delete(oldest)
    }
    listener(update)
  }

  const domHandler = (event: Event) => {
    deliver((event as CustomEvent<PortfolioDataUpdate>).detail)
  }

  const eventTarget = browserEventTarget()
  eventTarget?.addEventListener(DOM_EVENT_NAME, domHandler)

  const channel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(BROADCAST_CHANNEL_NAME)
    : null
  if (channel) channel.onmessage = (event: MessageEvent<PortfolioDataUpdate>) => deliver(event.data)

  return () => {
    eventTarget?.removeEventListener(DOM_EVENT_NAME, domHandler)
    channel?.close()
  }
}
